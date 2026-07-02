// OIDC SSO for the enterprise control plane (Stage 2). The org connects its IdP (Okta, Entra
// single-tenant, Auth0, Keycloak, Google Workspace) via ADA_OIDC_ISSUER; a terminal user runs the
// device flow in a browser and the backend maps the verified ID token to a seat (see enterprise.ts
// upsertSeatForSSO). ID-token verification is stdlib-only (node:crypto RS256 + JWKS) — no new dep.
//
// Fail-closed contract (hardened after an adversarial red-team):
//   - setting ADA_OIDC_ISSUER LOCKS the backend (see index.ts locked()), before any seat exists;
//   - provisioning requires a POSITIVE group/domain match — an empty allowlist refuses to start,
//     so a public/multi-tenant issuer can't JIT a seat for every account it will sign a token for;
//   - multi-tenant issuers (Entra common/organizations) are rejected at config load;
//   - seats key on `iss#sub` (issuer-scoped), so a reused `sub` across IdPs can't collide.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { isIP } from "node:net";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  audience: string;
  allowedGroups: string[];
  allowedDomains: string[];
  adminGroup?: string;
  groupClaim: string;
  nameClaim: string;
  jwksUri?: string;
  clockSkewMs: number;
  scope: string;
}

export interface OidcIdentity {
  iss: string;
  sub: string;
  name: string;
  email?: string;
  groups: string[];
}

/** OIDC is the master opt-in. Gates locked() in index.ts so the backend never falls to dev-open. */
export function oidcEnabled(): boolean {
  return !!process.env.ADA_OIDC_ISSUER;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Parse + VALIDATE the OIDC config from env. Throws (fail-closed) on any unsafe/incomplete config;
 *  call assertOidcConfig() once at startup so misconfiguration aborts the process instead of
 *  surfacing per-request. */
export function oidcConfig(): OidcConfig {
  const issuer = process.env.ADA_OIDC_ISSUER;
  if (!issuer) throw new Error("oidcConfig() called without ADA_OIDC_ISSUER");
  if (!/^https:\/\//i.test(issuer)) throw new Error("ADA_OIDC_ISSUER must be an https URL");
  // Multi-tenant issuers make `sub`/`iss` non-unique across tenants → reject (single-tenant only).
  if (/login\.microsoftonline\.com\/(common|organizations)(\/|$)/i.test(issuer) || /\{tenant\}|\{tenantid\}/i.test(issuer)) {
    throw new Error("multi-tenant OIDC issuer rejected — configure a concrete single-tenant issuer URL");
  }
  const clientId = process.env.ADA_OIDC_CLIENT_ID;
  if (!clientId) throw new Error("ADA_OIDC_CLIENT_ID is required when ADA_OIDC_ISSUER is set");
  const allowedGroups = list(process.env.ADA_OIDC_ALLOWED_GROUPS);
  const allowedDomains = list(process.env.ADA_OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase());
  // Positive allow-surface is mandatory: without it JIT would provision a seat for every identity
  // the IdP will sign a token for (esp. a public issuer). Refuse to start.
  if (!allowedGroups.length && !allowedDomains.length) {
    throw new Error("set ADA_OIDC_ALLOWED_GROUPS or ADA_OIDC_ALLOWED_DOMAINS — refusing to provision every IdP user (fail-closed)");
  }
  const jwksUri = process.env.ADA_OIDC_JWKS_URI;
  if (jwksUri) assertSafeJwksUri(jwksUri);
  return {
    issuer: stripSlash(issuer),
    clientId,
    audience: process.env.ADA_OIDC_AUDIENCE ?? clientId,
    allowedGroups,
    allowedDomains,
    adminGroup: process.env.ADA_OIDC_ADMIN_GROUP || undefined,
    groupClaim: process.env.ADA_OIDC_GROUP_CLAIM ?? "groups",
    nameClaim: process.env.ADA_OIDC_NAME_CLAIM ?? "",
    jwksUri,
    clockSkewMs: Number(process.env.ADA_OIDC_CLOCK_SKEW_MS) || 120_000,
    scope: process.env.ADA_OIDC_SCOPE ?? "openid profile email",
  };
}

/** Abort startup on bad OIDC config (called from index.ts). Returns true if OIDC is on and valid. */
export function assertOidcConfig(): boolean {
  if (!oidcEnabled()) return false;
  oidcConfig(); // throws on any problem
  return true;
}

function isPrivateV4(host: string): boolean {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
}

function isPrivateV6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  const mapped = /((?:\d{1,3}\.){3}\d{1,3})$/.exec(h);
  if (h.startsWith("::") && mapped) return isPrivateV4(mapped[1]!); // IPv4-mapped/compat → classify embedded v4
  const g = h.split(":")[0];
  if (!g) return true; // other ::-prefixed low addresses — refuse conservatively
  return /^fe[89ab]/.test(g) || /^f[cd]/.test(g); // fe80::/10 link-local, fc00::/7 ULA
}

// A jwks_uri must be https and must not point at loopback/link-local/private hosts — a lightweight
// SSRF guard for a typo'd/compromised issuer. Classification is against a PARSED IP (net.isIP),
// never a string prefix: WHATWG URL keeps IPv6 in brackets, and prefix tests both miss `[::1]` and
// falsely reject DNS names like `fcm.googleapis.com`. (We deliberately do NOT pin origin to the
// issuer: Google Workspace serves its JWKS from googleapis.com, a different origin than the issuer.)
export function assertSafeJwksUri(uri: string): void {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error(`invalid jwks_uri: ${uri}`);
  }
  if (u.protocol !== "https:") throw new Error(`jwks_uri must be https: ${uri}`);
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // unwrap IPv6 literal
  const fam = isIP(host); // 4, 6, or 0 (DNS name)
  if (fam === 0) {
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new Error(`jwks_uri host not allowed (loopback/internal): ${host}`);
    }
    return; // ordinary DNS name — resolves at fetch; the issuer is deployer-controlled
  }
  if (fam === 4 ? isPrivateV4(host) : isPrivateV6(host)) throw new Error(`jwks_uri host not allowed (private/loopback IP): ${host}`);
}

// ---- OIDC discovery (device/token/jwks endpoints), cached for the process ----
interface Discovery {
  device_authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
}
let discoveryCache: { at: number; doc: Discovery } | null = null;
let discoveryInflight: Promise<Discovery> | null = null;
let discoveryFailUntil = 0;
const DISCOVERY_TTL = 3_600_000; // endpoints are stable; refresh hourly

/** Cached OIDC discovery. Reached from the UNAUTHENTICATED /v1/auth/methods, so concurrent callers
 *  share one in-flight fetch and a failure is negative-cached briefly — a cold cache during an IdP
 *  outage can't fan out to one outbound request per anonymous caller. */
export async function discover(): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL) return discoveryCache.doc;
  if (Date.now() < discoveryFailUntil) throw new Error("OIDC discovery temporarily unavailable (cached failure)");
  if (discoveryInflight) return discoveryInflight;
  discoveryInflight = (async () => {
    try {
      const { issuer } = oidcConfig();
      const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status} at ${issuer}/.well-known/openid-configuration`);
      const doc = (await r.json()) as Discovery;
      if (doc.jwks_uri) assertSafeJwksUri(doc.jwks_uri);
      discoveryCache = { at: Date.now(), doc };
      return doc;
    } catch (e) {
      discoveryFailUntil = Date.now() + 10_000; // negative-cache 10s to stop pre-auth fan-out
      throw e;
    } finally {
      discoveryInflight = null;
    }
  })();
  return discoveryInflight;
}

// ---- JWKS cache with a fetch rate-cap (an attacker-chosen `kid` can't force unbounded refetches) ----
type Jwk = Record<string, unknown> & { kid?: string; kty?: string; use?: string; alg?: string };
const jwksCache = new Map<string, Jwk>();
let lastJwksFetch = 0;
const JWKS_MIN_REFETCH_MS = 60_000;

async function refreshJwks(): Promise<void> {
  lastJwksFetch = Date.now();
  const uri = oidcConfig().jwksUri ?? (await discover()).jwks_uri;
  if (!uri) throw new Error("no jwks_uri (set ADA_OIDC_JWKS_URI or fix discovery)");
  assertSafeJwksUri(uri);
  const r = await fetch(uri, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
  const { keys } = (await r.json()) as { keys?: Jwk[] };
  for (const k of keys ?? []) {
    if (k.kty === "RSA" && k.use !== "enc" && k.kid) jwksCache.set(k.kid, k);
  }
}

async function defaultGetKey(kid: string): Promise<Jwk | null> {
  const hit = jwksCache.get(kid);
  if (hit) return hit;
  if (Date.now() - lastJwksFetch > JWKS_MIN_REFETCH_MS) {
    await refreshJwks();
    return jwksCache.get(kid) ?? null;
  }
  return null; // rate-capped: unknown kid, refetched too recently
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Verify an OIDC ID token → identity, or null on ANY failure (bad alg/sig/claims). `opts.getKey`
 *  and `opts.now` are injectable for hermetic tests; production uses the JWKS cache + wall clock. */
export async function verifyOidcToken(
  idToken: string,
  opts: { getKey?: (kid: string) => Promise<Jwk | null> | Jwk | null; now?: number } = {},
): Promise<OidcIdentity | null> {
  const cfg = oidcConfig();
  const now = opts.now ?? Date.now();
  const getKey = opts.getKey ?? defaultGetKey;

  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null; // allowlist RS256 only — reject "none" and HS* (key confusion)

  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return null;
  let jwk: Jwk | null;
  try {
    jwk = await getKey(kid);
  } catch {
    return null; // JWKS/network error ⇒ deny
  }
  if (!jwk) return null;

  // Verify the RS256 signature over `header.payload`.
  let ok = false;
  try {
    const pub = createPublicKey({ key: jwk, format: "jwk" } as unknown as import("node:crypto").JsonWebKeyInput);
    ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"));
  } catch {
    return null;
  }
  if (!ok) return null;

  // Claims.
  const skew = cfg.clockSkewMs;
  if (payload.iss !== cfg.issuer) return null;
  const aud = payload.aud;
  const audArr = Array.isArray(aud) ? aud.map(String) : typeof aud === "string" ? [aud] : [];
  if (!audArr.includes(cfg.audience)) return null;
  // If aud carries extra resource ids we don't own AND azp is absent, reject (token minted for a
  // different client). When azp is present it must be our client id.
  if (typeof payload.azp === "string") {
    if (payload.azp !== cfg.clientId) return null;
  } else if (audArr.length > 1) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now - skew) return null;
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + skew) return null;
  if (typeof payload.iat === "number" && payload.iat * 1000 > now + skew) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;

  const groupsRaw = payload[cfg.groupClaim];
  const groups = Array.isArray(groupsRaw) ? groupsRaw.map(String) : typeof groupsRaw === "string" ? [groupsRaw] : [];
  // Only trust `email` when the IdP marks it verified — domain-based provisioning (isProvisionAllowed)
  // matches on the email domain, and a self-service IdP will happily sign a token for an unverified
  // attacker@corp.com. IdPs that omit email_verified simply can't use the domain allowlist (use groups).
  const email = payload.email_verified === true && typeof payload.email === "string" ? payload.email : undefined;
  const name =
    (cfg.nameClaim && typeof payload[cfg.nameClaim] === "string" && (payload[cfg.nameClaim] as string)) ||
    email ||
    (typeof payload.preferred_username === "string" ? payload.preferred_username : undefined) ||
    (payload.sub as string);

  return { iss: cfg.issuer, sub: payload.sub, name, email, groups };
}

/** Positive, fail-closed membership: true iff the identity is in an allowed group OR email domain.
 *  oidcConfig() already refuses to start with an empty allow-surface, so this is never vacuously true. */
export function isProvisionAllowed(id: OidcIdentity): boolean {
  const cfg = oidcConfig();
  if (cfg.allowedGroups.length && id.groups.some((g) => cfg.allowedGroups.includes(g))) return true;
  if (cfg.allowedDomains.length && id.email) {
    const domain = id.email.split("@")[1]?.toLowerCase();
    if (domain && cfg.allowedDomains.includes(domain)) return true;
  }
  return false;
}

/** Map a verified identity to seat fields. externalId is issuer-scoped (`iss#sub`); admin role only
 *  when the configured admin group is present in the token. */
export function mapIdentityToSeatFields(id: OidcIdentity): { externalId: string; iss: string; name: string; role: "admin" | "dev" } {
  const cfg = oidcConfig();
  const role: "admin" | "dev" = cfg.adminGroup && id.groups.includes(cfg.adminGroup) ? "admin" : "dev";
  return { externalId: `${id.iss}#${id.sub}`, iss: id.iss, name: id.name, role };
}
