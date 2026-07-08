// Better Auth — accounts, sessions, API keys (seat keys), device flow for CLI/IDE sign-in.
// Self-hosted on SQLite (ada-auth.db next to the repo); social providers activate only when
// their env creds are present. Docs: https://www.better-auth.com
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import Database from "better-sqlite3";

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET };
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "ada-dev-secret-change-in-production",
  database: new Database(process.env.ADA_AUTH_DB ?? "ada-auth.db"),
  emailAndPassword: { enabled: true },
  socialProviders,
  plugins: [
    bearer(), // Authorization: Bearer <session token> works everywhere
    deviceAuthorization({ expiresIn: "10m", interval: "5s" }), // CLI/IDE device sign-in
  ],
});

/** True if the bearer token is a valid Better Auth session token. (Long-lived seat
 *  keys stay on the native ada_sk_ system — no duplicate key store.) */
export async function verifyBetterAuth(token: string): Promise<boolean> {
  try {
    const s = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    return !!s?.user;
  } catch {
    return false;
  }
}
