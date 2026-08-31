// Token exchange for connectors whose OAuth provider will not register a client (Google).
//
// The desktop app still runs the flow: it opens the consent page, catches the loopback redirect and
// holds the PKCE verifier. It just cannot finish, because the final token request needs a client
// secret. Rather than ship that secret in every installer, the app sends the code here and this
// completes the exchange. TOKENS ARE RETURNED, NOT STORED — they stay on the user's machine, and
// this service holds no calendar or mail access on anyone's behalf.
//
// What makes this safe is the allowlist. Without it the endpoint is an open relay: anyone could
// post an arbitrary `token_endpoint` and have us attach Ada's secret to it.

/**
 * Providers we hold credentials for, keyed by the token endpoint host we will talk to.
 *
 * All three are here for the same reason: their authorization servers do not offer dynamic client
 * registration (probed — no registration_endpoint in any of their metadata), so the only way to a
 * one-click sign-in is Ada's own registered app. Two env vars per provider, nothing in any client:
 *   ADA_MCP_OAUTH_GOOGLE_CLIENT_ID/_SECRET  → oauth2.googleapis.com
 *   ADA_MCP_OAUTH_GITHUB_CLIENT_ID/_SECRET  → github.com   (Ada already has a GitHub OAuth app)
 *   ADA_MCP_OAUTH_SLACK_CLIENT_ID/_SECRET   → slack.com
 *   ADA_MCP_OAUTH_X_CLIENT_ID/_SECRET       → api.x.com
 *   ADA_MCP_OAUTH_LINKEDIN_CLIENT_ID/_SECRET → www.linkedin.com
 */
function providers(): Record<string, { client_id: string; client_secret: string; provider: string }> {
  const defs: [envKey: string, host: string, provider: string][] = [
    ["GOOGLE", "oauth2.googleapis.com", "google"],
    ["GITHUB", "github.com", "github"],
    ["SLACK", "slack.com", "slack"],
    // Neither is an MCP server; both are plain OAuth 2 + REST. They are here for the same reason as
    // the others — no dynamic client registration — and additionally because posting scopes are
    // granted per REGISTERED APP, so there is no version of this where the client lives on the
    // user's machine. X's token endpoint requires the secret even for a "public" PKCE client.
    ["X", "api.x.com", "x"],
    ["LINKEDIN", "www.linkedin.com", "linkedin"],
  ];
  const out: Record<string, { client_id: string; client_secret: string; provider: string }> = {};
  for (const [key, host, provider] of defs) {
    const id = process.env[`ADA_MCP_OAUTH_${key}_CLIENT_ID`];
    const secret = process.env[`ADA_MCP_OAUTH_${key}_CLIENT_SECRET`];
    if (id && secret) out[host] = { client_id: id, client_secret: secret, provider };
  }
  return out;
}

/** Whether this deployment can complete any exchange at all — reported so the client can skip it. */
export function exchangeHosts(): string[] {
  return Object.keys(providers());
}

/**
 * Providers configured HALF way — an id with no secret, or a secret with no id.
 *
 * `providers()` requires both, so a half-set provider silently vanishes: the connector shows
 * "Unavailable" and nothing anywhere says why. That is the likeliest mistake when setting these up
 * (paste the id, come back for the secret later), and it is invisible precisely when someone is
 * looking for it. Names only — never a value, not even a length.
 */
export function exchangeMisconfigured(): string[] {
  const out: string[] = [];
  for (const key of ["GOOGLE", "GITHUB", "SLACK", "X", "LINKEDIN"]) {
    const id = process.env[`ADA_MCP_OAUTH_${key}_CLIENT_ID`];
    const secret = process.env[`ADA_MCP_OAUTH_${key}_CLIENT_SECRET`];
    if (!id && !secret) continue; // not set up at all — deliberate, not a mistake
    if (!id) out.push(`${key.toLowerCase()} (secret set, CLIENT_ID missing)`);
    else if (!secret) out.push(`${key.toLowerCase()} (id set, CLIENT_SECRET missing)`);
  }
  return out;
}

/**
 * The CLIENT IDS this deployment will sign users in with — ids only, never secrets.
 *
 * A client id is public by construction: it travels in the consent URL in the user's own browser.
 * Publishing it here is what removes the setup box from the app — the desktop client can build the
 * authorize URL without anybody pasting anything, while the secret stays here and is only ever used
 * in the token exchange above.
 */
export function exchangeClients(): Record<string, { client_id: string; provider: string }> {
  const out: Record<string, { client_id: string; provider: string }> = {};
  for (const [host, p] of Object.entries(providers())) out[host] = { client_id: p.client_id, provider: p.provider };
  return out;
}

export interface ExchangeRequest {
  token_endpoint?: string;
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  refresh_token?: string;
  resource?: string;
  scope?: string;
}

/**
 * Complete an authorization-code or refresh exchange using this deployment's client credentials.
 *
 * Deliberately narrow: only the two grant types a connector sign-in uses, only hosts in the map,
 * and only the fields that belong in a token request. A general-purpose forwarder here would be a
 * way to borrow Ada's identity.
 */
export async function handleMcpOauthExchange(
  body: ExchangeRequest,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const endpoint = String(body.token_endpoint ?? "");
  let host: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return { status: 400, json: { error: "token_endpoint must be https" } };
    host = u.hostname.toLowerCase();
  } catch {
    return { status: 400, json: { error: "token_endpoint is not a URL" } };
  }

  const provider = providers()[host];
  // Not an error the client should retry differently — it means finish the exchange yourself.
  if (!provider) return { status: 404, json: { error: `no client configured for ${host}`, hosts: exchangeHosts() } };

  const grant = body.grant_type === "refresh_token" ? "refresh_token" : "authorization_code";
  const form = new URLSearchParams({
    grant_type: grant,
    client_id: provider.client_id,
    client_secret: provider.client_secret,
    ...(grant === "authorization_code"
      ? {
          code: String(body.code ?? ""),
          code_verifier: String(body.code_verifier ?? ""),
          redirect_uri: String(body.redirect_uri ?? ""),
        }
      : { refresh_token: String(body.refresh_token ?? "") }),
    ...(body.resource ? { resource: String(body.resource) } : {}),
    ...(body.scope ? { scope: String(body.scope) } : {}),
  });

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // Passed straight back to the caller and never written down — that is the whole design.
    return { status: r.ok ? 200 : 400, json: j };
  } catch (e) {
    return { status: 502, json: { error: e instanceof Error ? e.message : String(e) } };
  }
}
