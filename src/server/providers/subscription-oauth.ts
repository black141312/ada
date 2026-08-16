// Subscription login: use a Claude Pro/Max or ChatGPT Plus/Pro account as a provider key,
// instead of a pay-per-token API key.
//
// Both are OAuth 2.0 authorization-code + PKCE flows against a loopback redirect — the same flow
// the vendors' own CLIs use, with their public client ids (a client_id is not a secret; it appears
// in the browser URL and identifies the *app*, not the user). The port and path below are
// REGISTERED with those OAuth apps: they cannot be changed, which is why they're constants and not
// env-driven like the device-flow config in ../oauth.ts.
//
// The resulting tokens land in ~/.ada/credentials.json as normal `oauth` credentials, so the rest
// of the backend (providerKey / isConfigured / providerStatus) already understands them. Access
// tokens are short-lived; `freshToken()` refreshes them in-place before each use.
//
// Remote/headless box: there's no browser to catch the redirect. Forward the port first —
//   ssh -L 53692:localhost:53692 you@box     (claude)
//   ssh -L 1455:localhost:1455   you@box     (chatgpt)
// ponytail: loopback only, no paste-the-code fallback. Add one if port forwarding proves too
// awkward in practice — it's ~20 lines (parse `code`+`state` out of a pasted redirect URL).

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { getCredential, setCredential } from "../credentials.ts";

/** Providers whose key can come from a consumer subscription rather than an API key. */
export type SubscriptionProvider = "anthropic" | "chatgpt";

interface FlowConfig {
  label: string; // what the user sees ("Claude Pro/Max")
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  port: number; // registered with the OAuth app — not configurable
  path: string; // ditto
  scope: string;
  extraAuthParams?: Record<string, string>;
  /** Anthropic wants JSON at the token endpoint; OpenAI wants form-encoded. */
  tokenEncoding: "json" | "form";
  /** Anthropic echoes the PKCE verifier as `state` and requires it back on exchange. */
  stateIsVerifier?: boolean;
}

const FLOWS: Record<SubscriptionProvider, FlowConfig> = {
  anthropic: {
    label: "Claude Pro/Max",
    clientId: atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"),
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    port: 53692,
    path: "/callback",
    scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    extraAuthParams: { code: "true" },
    tokenEncoding: "json",
    stateIsVerifier: true,
  },
  chatgpt: {
    label: "ChatGPT Plus/Pro",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    port: 1455,
    path: "/auth/callback",
    scope: "openid profile email offline_access",
    extraAuthParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "ada" },
    tokenEncoding: "form",
  },
};

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>ada</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p style="color:#666">${body}</p></div></body>`;

/** Serve the loopback redirect until the provider sends us back a code (or `timeoutMs` elapses). */
function awaitCallback(cfg: FlowConfig, expectedState: string, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // `connection: close` tells the browser not to keep the socket alive, so the teardown below has
    // nothing left to destroy in the normal case. This page is served exactly once either way.
    const HTML = { "content-type": "text/html; charset=utf-8", connection: "close" };

    const server = createServer((req, res) => {
      // Settle only once the page has actually flushed — done() destroys the socket, and doing that
      // first would leave the user looking at a truncated page instead of "Signed in ✓".
      const reply = (status: number, html: string, then: () => void): void => {
        res.writeHead(status, HTML);
        res.end(html, then);
      };
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== cfg.path) {
        // Not the redirect — answer it but keep waiting for the real one.
        res.writeHead(404, HTML);
        res.end(PAGE("Not found", "Wrong callback path."));
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const fail = (msg: string): void => reply(400, PAGE("Login failed", msg), () => done(new Error(msg)));

      if (err) return fail(url.searchParams.get("error_description") ?? err);
      if (!code) return fail("no authorization code in the redirect");
      // The state check is what stops a hostile page in the same browser from feeding us its own
      // code (login CSRF) — without it, ada could end up holding an attacker's account token.
      if (state !== expectedState) return fail("state mismatch — ignoring this redirect");
      reply(200, PAGE("Signed in ✓", "You can close this tab and return to ada."), () => done(null, code));
    });

    let settled = false;
    const done = (e: Error | null, code?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `close()` only stops *listening* — the browser's keep-alive connection survives it and holds
      // an open TCP handle for the rest of the process's life. The CLI then exits explicitly, and
      // tearing libuv down with that handle still open aborts on Windows:
      //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
      // which lands *after* a successful login and turns exit 0 into 127. Drop the connection first.
      server.closeAllConnections();
      server.close();
      if (e) reject(e);
      else resolve(code!);
    };
    const timer = setTimeout(() => done(new Error("login timed out")), timeoutMs);

    server.on("error", (e: NodeJS.ErrnoException) => {
      done(
        new Error(
          e.code === "EADDRINUSE"
            ? `port ${cfg.port} is busy — another login (or the vendor's own CLI) is mid-flow. Close it and retry; the port is fixed by the OAuth app and can't be changed.`
            : `callback server failed: ${e.message}`,
        ),
      );
    });
    // 127.0.0.1, not 0.0.0.0: the auth code must not be reachable from the network.
    server.listen(cfg.port, "127.0.0.1");
  });
}

/** Escape cmd.exe's metacharacters so `start` receives the URL as one token. */
export const cmdEscape = (s: string): string => s.replace(/[&^|<>]/g, (c) => `^${c}`);

function openBrowser(url: string): void {
  try {
    // `cmd /c start` re-parses its command line, and `&` is cmd's command separator — an unescaped
    // OAuth URL arrives at the browser truncated at the first parameter ("Missing client_id"), which
    // looks like a server-side rejection rather than a quoting bug. Carets escape it; quoting does
    // not, because Node escapes the quotes we'd add. No other platform re-parses the argument.
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", cmdEscape(url)]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(cmd!, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* headless — the printed URL is the fallback */
  }
}

interface Tokens {
  access: string;
  refresh?: string;
  expires?: number;
}

async function postTokens(cfg: FlowConfig, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": cfg.tokenEncoding === "json" ? "application/json" : "application/x-www-form-urlencoded" },
    body: cfg.tokenEncoding === "json" ? JSON.stringify(params) : new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  let j: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    throw new Error(`token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!j.access_token) throw new Error(`token endpoint returned no access_token: ${text.slice(0, 200)}`);
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    // Refresh a minute early: a token that expires mid-request is a failed request.
    expires: j.expires_in ? Date.now() + j.expires_in * 1000 - 60_000 : undefined,
  };
}

/** Run the browser login for `provider` and store the tokens. Throws with a usable message. */
export async function subscriptionLogin(provider: SubscriptionProvider, print: (s: string) => void): Promise<void> {
  const cfg = FLOWS[provider];
  const { verifier, challenge } = pkce();
  const state = cfg.stateIsVerifier ? verifier : randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${cfg.port}${cfg.path}`;

  const auth = new URL(cfg.authorizeUrl);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...cfg.extraAuthParams,
  })) {
    auth.searchParams.set(k, v);
  }

  // Start listening BEFORE the browser opens, or a fast redirect hits a closed port.
  const waiting = awaitCallback(cfg, state);
  print(`\nSign in to ${cfg.label} in your browser:\n  ${auth.toString()}\n`);
  print("(opening it for you — waiting for the redirect…)");
  openBrowser(auth.toString());

  const code = await waiting;
  const tokens = await postTokens(cfg, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...(cfg.stateIsVerifier ? { state } : {}),
  });

  await setCredential(provider, { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires });
  print(`\x1b[32m✓ signed in to ${cfg.label}\x1b[0m — ada now bills this account instead of an API key.`);

  // Say it here rather than letting the first request fail with a message about model ids.
  if (provider === "chatgpt") {
    const plan = chatgptPlan(tokens.access);
    if (planLacksCodex(plan)) {
      print(`\x1b[33mwarning: this account is on the ${plan} plan, which can't use Codex — every model will be refused. Upgrade to Plus/Pro, or use an OPENAI_API_KEY instead.\x1b[0m`);
    }
  }
}

// One refresh per provider at a time. Two concurrent requests both seeing an expired token would
// otherwise each burn the refresh token; the loser's next call would 401 on a rotated token.
const refreshing = new Map<string, Promise<string>>();

async function doRefresh(provider: SubscriptionProvider, refresh: string): Promise<string> {
  const cfg = FLOWS[provider];
  const t = await postTokens(cfg, { grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: refresh });
  await setCredential(provider, {
    type: "oauth",
    access: t.access,
    refresh: t.refresh ?? refresh, // some providers rotate, some don't — keep the old one if not
    expires: t.expires,
  });
  return t.access;
}

/**
 * The access token to send upstream for `provider`, refreshed if it's expired or about to be.
 * Returns "" when there's no subscription credential — callers fall back to the API-key path.
 */
export async function freshToken(provider: SubscriptionProvider): Promise<string> {
  const cred = getCredential(provider);
  if (!cred || cred.type !== "oauth" || !cred.access) return "";
  if (!cred.expires || Date.now() < cred.expires) return cred.access;
  if (!cred.refresh) return cred.access; // no way to renew — let upstream 401 say so

  const inflight = refreshing.get(provider);
  if (inflight) return inflight;
  const p = doRefresh(provider, cred.refresh).finally(() => refreshing.delete(provider));
  refreshing.set(provider, p);
  return p;
}

/** True when `provider` is backed by a subscription login rather than an API key. */
export function hasSubscription(provider: SubscriptionProvider): boolean {
  const c = getCredential(provider);
  return c?.type === "oauth" && !!c.access;
}

/** The `https://api.openai.com/auth` claim block out of a ChatGPT token, or null if it isn't a JWT. */
function chatgptAuthClaims(token: string): { chatgpt_account_id?: string; chatgpt_plan_type?: string } | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return (claims["https://api.openai.com/auth"] as { chatgpt_account_id?: string; chatgpt_plan_type?: string }) ?? null;
  } catch {
    return null; // not a JWT (a pasted opaque token)
  }
}

/** The ChatGPT account id, which the Codex endpoint requires as a header. It rides in the JWT. */
export function chatgptAccountId(token: string): string {
  return chatgptAuthClaims(token)?.chatgpt_account_id ?? "";
}

/** The plan this token belongs to ("free", "plus", "pro", …), or "" if the token doesn't say.
 *
 *  Worth checking before blaming anything else: on a free plan the Codex endpoint rejects EVERY
 *  model id with "The '<id>' model is not supported when using Codex with a ChatGPT account", which
 *  reads like the id is wrong and sends you hunting through model names that were never the problem. */
export function chatgptPlan(token: string): string {
  return chatgptAuthClaims(token)?.chatgpt_plan_type ?? "";
}

/** True when this plan can't use Codex at all. Only "free" is known to be excluded — anything else
 *  is assumed usable rather than guessed at, so a new plan name can't be wrongly blocked here. */
export const planLacksCodex = (plan: string): boolean => plan === "free";

/** What users actually type. The plan name and the provider name both work — `login claude` and
 *  `login anthropic` are the same thing — so every surface (CLI, TUI, desktop) accepts the same set
 *  instead of each inventing its own. Returns undefined for anything else. */
export const subscriptionFor = (arg: string): SubscriptionProvider | undefined =>
  ({ claude: "anthropic", anthropic: "anthropic", chatgpt: "chatgpt", codex: "chatgpt" }) [arg.trim().toLowerCase()] as
    | SubscriptionProvider
    | undefined;

export const SUBSCRIPTION_LABELS: Record<SubscriptionProvider, string> = {
  anthropic: FLOWS.anthropic.label,
  chatgpt: FLOWS.chatgpt.label,
};

/** demo(): `node --experimental-strip-types subscription-oauth.ts` — checks the pieces that can be
 *  checked without a real account (PKCE shape, auth URL params, state-mismatch rejection). */
async function demo(): Promise<void> {
  const assert = (c: unknown, m: string): void => {
    if (!c) throw new Error(`FAIL: ${m}`);
  };
  const { verifier, challenge } = pkce();
  assert(!/[+/=]/.test(verifier + challenge), "PKCE values are base64url (no + / =)");
  assert(challenge === b64url(createHash("sha256").update(verifier).digest()), "challenge is S256(verifier)");
  assert(verifier.length >= 43, "verifier is long enough for RFC 7636");

  for (const p of ["anthropic", "chatgpt"] as SubscriptionProvider[]) {
    const cfg = FLOWS[p];
    assert(cfg.clientId.length > 10, `${p} has a client id`);
    assert(cfg.authorizeUrl.startsWith("https://"), `${p} authorize is https`);
  }
  assert(FLOWS.anthropic.stateIsVerifier === true, "anthropic echoes the verifier as state");

  // A redirect carrying the wrong state must be rejected, not accepted.
  const cfg = { ...FLOWS.chatgpt, port: 1 + Math.floor(Math.random() * 20000) + 40000 };
  // Settle into a value up front: attaching the handler later would leave a window where the
  // rejection is unhandled, which crashes the process before the assert can run.
  const outcome = awaitCallback(cfg, "expected-state", 5000).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  await new Promise((r) => setTimeout(r, 200));

  // Drive it with a KEEP-ALIVE client, the way a browser does. A plain fetch closes its own socket
  // and so hides the leak: server.close() leaves a keep-alive connection open, that lingering TCP
  // handle is what aborts libuv during the CLI's explicit exit, and the abort lands after a
  // successful login — turning exit 0 into 127.
  const { Agent, request } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  const body = await new Promise<string>((done) => {
    request({ host: "127.0.0.1", port: cfg.port, path: `${cfg.path}?code=abc&state=WRONG`, agent }, (r) => {
      let s = "";
      r.on("data", (c: Buffer) => (s += c.toString()));
      r.on("end", () => done(s));
    }).end();
  });
  assert(/state mismatch/.test(await outcome), "a code arriving with the wrong state is rejected");
  assert(/<\/body>/.test(body), "the page is flushed whole, not truncated by the socket teardown");
  await new Promise((r) => setTimeout(r, 200));
  const leaked = process.getActiveResourcesInfo().filter((h) => h === "TCPSocketWrap");
  assert(leaked.length === 0, `the callback socket must not outlive the flow, found ${leaked.length}`);

  // The browser handoff: on Windows an unescaped `&` truncates the URL at the first parameter, and
  // the only visible symptom is claude.ai saying "Missing client_id". Round-trip a URL through the
  // same shell `start` uses and check every parameter survives.
  if (process.platform === "win32") {
    const { spawnSync } = await import("node:child_process");
    const url = "https://claude.ai/oauth/authorize?response_type=code&client_id=abc&scope=x%3Ay&state=s";
    const echoed = spawnSync("cmd", ["/c", "echo", cmdEscape(url)], { encoding: "utf8" }).stdout.trim();
    assert(echoed === url, `cmd must receive the whole URL, got: ${echoed}`);
  }

  assert(chatgptAccountId("not-a-jwt") === "", "non-JWT token yields no account id");
  const mk = (c: Record<string, string>): string => `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": c })).toString("base64url")}.y`;
  assert(chatgptAccountId(mk({ chatgpt_account_id: "acct_1" })) === "acct_1", "account id is read from the JWT claim");
  assert(chatgptPlan(mk({ chatgpt_plan_type: "free" })) === "free", "plan type is read from the JWT claim");
  assert(planLacksCodex("free"), "free is the plan that can't use Codex");
  // Every surface routes through this, so a wrong answer here misroutes the CLI, the TUI and the app.
  assert(subscriptionFor("claude") === "anthropic" && subscriptionFor("anthropic") === "anthropic", "claude and anthropic both mean Claude");
  assert(subscriptionFor("chatgpt") === "chatgpt" && subscriptionFor("codex") === "chatgpt", "chatgpt and codex both mean ChatGPT");
  assert(subscriptionFor(" Claude ") === "anthropic", "input is trimmed and case-folded");
  assert(subscriptionFor("") === undefined && subscriptionFor("openai") === undefined, "unknown names are rejected, not guessed");
  assert(!planLacksCodex("plus") && !planLacksCodex("pro") && !planLacksCodex(""), "paid and unknown plans are not blocked");

  console.log("subscription-oauth: all checks passed");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/subscription-oauth.ts")) void demo();
