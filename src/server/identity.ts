// Identity verification for "sign in with GitHub / Google". A login token is an IDENTITY
// ("this is user X"), not a provider key — so the backend verifies it with the provider and
// (optionally) checks an allowlist, instead of using it to call a model. Results are cached
// briefly to avoid hitting the provider on every request.

interface Identity {
  provider: string;
  user: string;
}

const cache = new Map<string, { id: Identity; exp: number }>();
const TTL = 5 * 60_000;

async function verifyGitHub(token: string): Promise<Identity | null> {
  const r = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, "user-agent": "ada", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(4000), // never let identity verification hang a request
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { login?: string };
  return j.login ? { provider: "github", user: j.login } : null;
}

async function verifyGoogle(token: string): Promise<Identity | null> {
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) return null;
  const j = (await r.json()) as { email?: string };
  return j.email ? { provider: "google", user: j.email } : null;
}

/** Resolve a bearer token to an identity (GitHub or Google), or null. */
export async function verifyIdentity(token: string): Promise<Identity | null> {
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.id;

  let id: Identity | null = null;
  try {
    if (/^gh[opsu]_/.test(token) || token.startsWith("github_pat_")) id = await verifyGitHub(token);
    else if (token.startsWith("ya29.")) id = await verifyGoogle(token);
    else id = (await verifyGitHub(token)) ?? (await verifyGoogle(token)); // unknown shape: try both
  } catch {
    id = null;
  }
  if (id) cache.set(token, { id, exp: Date.now() + TTL });
  return id;
}

/** Allowed login users (GitHub logins / Google emails), or null = any authenticated user. */
export function allowedUsers(): string[] | null {
  const v = process.env.ADA_ALLOWED_USERS;
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isAllowed(user: string): boolean {
  const a = allowedUsers();
  return !a || a.includes(user);
}
