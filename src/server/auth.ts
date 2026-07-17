// Better Auth — accounts, sessions, API keys (seat keys), device flow for CLI/IDE sign-in.
// Self-hosted on SQLite (ada-auth.db next to the repo); social providers activate only when
// their env creds are present. Docs: https://www.better-auth.com
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import Database from "better-sqlite3";
import { Pool } from "pg";

// Storage: a hosted Postgres (Supabase) when DATABASE_URL is set — makes the backend STATELESS, so it
// runs on any serverless/container host without a persistent disk. Falls back to local SQLite for dev.
const authDatabase = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Database(process.env.ADA_AUTH_DB ?? "ada-auth.db");

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET };
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
}

// The signing/encryption secret. A dev fallback is fine ONLY while Better Auth is off (its tokens
// aren't honored then). The instant accounts gate the backend, a real, non-default secret is REQUIRED
// — else the constant that ships in this repo would let anyone forge sessions. Fail closed.
const DEV_SECRET = "ada-dev-secret-change-in-production";
const rawSecret = process.env.BETTER_AUTH_SECRET?.trim();
const authSecret = rawSecret || DEV_SECRET; // truthiness, not ??: a blank/whitespace value also falls to the default so the guard below catches it
if (betterAuthEnabled() && authSecret === DEV_SECRET) {
  throw new Error("BETTER_AUTH_SECRET must be set to a strong, unique value when BETTER_AUTH_ENABLED is on (the built-in dev default is refused).");
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  secret: authSecret,
  database: authDatabase,
  emailAndPassword: { enabled: true },
  socialProviders,
  plugins: [
    bearer(), // Authorization: Bearer <session token> works everywhere
    deviceAuthorization({ expiresIn: "10m", interval: "5s" }), // CLI/IDE device sign-in
  ],
});

/** Resolve a Better Auth session token to WHO it is (email, else user id), or null. Returning the
 *  identity — not just a boolean — keeps per-user metering/audit intact for account logins. (Long-lived
 *  seat keys stay on the native ada_sk_ system — no duplicate key store.) */
export async function verifyBetterAuth(token: string): Promise<string | null> {
  try {
    const s = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    return s?.user ? (s.user.email ?? s.user.id) : null;
  } catch {
    return null;
  }
}

/** Whether Better Auth accounts GATE the backend. Opt-in via BETTER_AUTH_ENABLED — the /api/auth
 *  routes are always mounted (so accounts can be created), but only this flag makes login REQUIRED
 *  (adds to locked()), so turning on accounts can't leave the backend dev-open. */
export function betterAuthEnabled(): boolean {
  return process.env.BETTER_AUTH_ENABLED === "1" || process.env.BETTER_AUTH_ENABLED === "true";
}
