// GitHub Copilot bearer-token exchange. Copilot's endpoint doesn't take a GitHub token directly —
// you exchange one at /copilot_internal/v2/token for a short-lived bearer. Ways in, in order:
//   COPILOT_API_KEY      — you already have a bearer (pasted from another tool); used as-is.
//   COPILOT_GITHUB_TOKEN — a GitHub OAuth token with Copilot access; exchanged + cached here,
//                          refreshed automatically before expiry.
//   stored credential    — whatever `ada login`-style credential storage holds for copilot.
// Untested against a live subscription (needs one) — the exchange shape matches the documented
// flow used by editor integrations; failures surface as a normal upstream error to the client.

import { providerKey } from "../config.ts";

let cached: { token: string; expiresAt: number } | null = null;

/** Drop the cached bearer (e.g. after an upstream 401 — revoked token or clock skew). */
export function invalidateCopilotBearer(): void {
  cached = null;
}

/** The bearer to send to api.githubcopilot.com, or "" if no Copilot credentials are configured. */
export async function copilotBearer(): Promise<string> {
  const direct = process.env.COPILOT_API_KEY;
  if (direct) return direct;
  const gh = process.env.COPILOT_GITHUB_TOKEN;
  if (!gh) return providerKey("copilot") ?? ""; // stored credential, or unconfigured
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { authorization: `token ${gh}`, "user-agent": "ada" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Copilot token exchange failed: HTTP ${res.status} — is COPILOT_GITHUB_TOKEN a GitHub token on an account with a Copilot subscription?`);
  const j = (await res.json()) as { token?: string; expires_at?: number };
  if (!j.token) throw new Error("Copilot token exchange returned no token");
  cached = { token: j.token, expiresAt: (j.expires_at ?? Math.floor(Date.now() / 1000) + 600) * 1000 };
  return cached.token;
}
