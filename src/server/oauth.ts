// OAuth 2.0 Device Authorization Grant (RFC 8628). Works against any compliant provider
// (GitHub, Google, …). Provider client IDs / endpoints are env-driven because they are
// provider-specific: ADA_OAUTH_<PROVIDER>_{CLIENT_ID,DEVICE_URL,TOKEN_URL,SCOPE}.

import { setCredential } from "./credentials.ts";

export interface OAuthConfig {
  clientId: string;
  deviceUrl: string;
  tokenUrl: string;
  scope?: string;
  clientSecret?: string; // GitHub device flow omits this; Google requires it
}

// Built-in OAuth app config. A client_id and these endpoints are PUBLIC (they show up in browser
// URLs) — they identify the *app* (ada), not the user — so we ship them. Like `gh`, the user sets
// nothing. Env vars (ADA_OAUTH_<P>_*) override, e.g. to point ada at your own OAuth app.
const DEFAULTS: Record<string, Partial<OAuthConfig>> = {
  github: {
    clientId: "Ov23lirXtvfJWAt9C8et",
    deviceUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user",
  },
  google: {
    // Google device flow needs a client_id (+ secret) from your own GCP project — set via env.
    deviceUrl: "https://oauth2.googleapis.com/device/code",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email",
  },
};

export function oauthConfig(provider: string): OAuthConfig | null {
  const up = provider.toUpperCase();
  const d = DEFAULTS[provider] ?? {};
  const clientId = process.env[`ADA_OAUTH_${up}_CLIENT_ID`] ?? d.clientId;
  const deviceUrl = process.env[`ADA_OAUTH_${up}_DEVICE_URL`] ?? d.deviceUrl;
  const tokenUrl = process.env[`ADA_OAUTH_${up}_TOKEN_URL`] ?? d.tokenUrl;
  if (!clientId || !deviceUrl || !tokenUrl) return null;
  return {
    clientId,
    deviceUrl,
    tokenUrl,
    scope: process.env[`ADA_OAUTH_${up}_SCOPE`] ?? d.scope,
    clientSecret: process.env[`ADA_OAUTH_${up}_CLIENT_SECRET`] ?? d.clientSecret,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Run the device flow: print the user code, poll, and RETURN the raw token response (access_token,
 *  id_token, refresh_token, …) without storing anything. Callers decide what to persist — GitHub/Google
 *  store the access token (deviceLogin below); OIDC SSO exchanges the id_token for a seat key. */
export async function deviceGrant(provider: string, cfg: OAuthConfig, print: (s: string) => void): Promise<Record<string, unknown>> {
  const secret: Record<string, string> = cfg.clientSecret ? { client_secret: cfg.clientSecret } : {};
  const dev = await postForm(cfg.deviceUrl, { client_id: cfg.clientId, scope: cfg.scope ?? "", ...secret });
  const deviceCode = dev.device_code as string;
  if (!deviceCode) throw new Error(`device request failed: ${JSON.stringify(dev)}`);
  print(`\nTo log in to ${provider}, open:\n  ${dev.verification_uri ?? dev.verification_uri_complete ?? dev.verification_url}`);
  print(`and enter the code:  ${dev.user_code}\n`);

  const interval = (Number(dev.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(dev.expires_in) || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tok = await postForm(cfg.tokenUrl, {
      client_id: cfg.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      ...secret,
    });
    if (tok.access_token || tok.id_token) return tok;
    const err = tok.error as string | undefined;
    if (err && err !== "authorization_pending" && err !== "slow_down") {
      throw new Error((tok.error_description as string) ?? err);
    }
  }
  throw new Error("device login timed out");
}

/** Device flow for identity providers (GitHub/Google): grant, then store the access token. */
export async function deviceLogin(provider: string, cfg: OAuthConfig, print: (s: string) => void): Promise<void> {
  const tok = await deviceGrant(provider, cfg, print);
  await setCredential(provider, {
    type: "oauth",
    access: tok.access_token as string,
    refresh: tok.refresh_token as string | undefined,
    expires: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : undefined,
  });
  print(`Logged in to ${provider}.`);
}
