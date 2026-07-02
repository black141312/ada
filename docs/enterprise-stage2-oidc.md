# Enterprise Stage 2 — OIDC SSO + JIT seat provisioning

Status: **shipped in 0.8.0**. This is the design record; the operator runbook is in
[enterprise.md](enterprise.md#sso-oidc--federate-login-to-your-idp).

## Why this, and why not SAML

After Stage 1 (seats, model allowlist, provider pinning, metering, audit), the #1 enterprise
security-review gate for a tool that **holds provider API keys** and **reads source code** is
centralized identity with provable, timely deprovisioning — *"when Alice is offboarded, is her access
gone in minutes?"* Static `ada_sk_` seat keys can't answer that.

OIDC beat the alternatives on unblock-value ÷ cost, grounded in the real code:

- **vs SAML** — a terminal has no device grant, so SAML needs a brand-new loopback auth-code+PKCE
  flow *and* an XML-DSig / exclusive-C14N assertion verifier that Node's stdlib can't provide (forcing
  a dependency or a hand-rolled, XSW-prone verifier). OIDC reuses the existing RFC 8628 device flow
  (`oauth.ts`) and needs only stdlib RS256/JWKS verification. Most SAML-mandating IdPs speak OIDC too.
  SAML is deferred to a fast-follow for a contractually SAML-only account.
- **vs a seatless verify-only login** — real buyers gate on *demonstrable* deprovisioning (SOC 2
  CC6.3 / ISO 27001 A.9.2.6). Verify-only bounds revocation by IdP token lifetime with no kill switch.
  We take exactly one rung more: a JIT seat + an immediate `disable-by-externalId` admin endpoint.

Ranking: **oidc-sso (build now) > SCIM (Stage 3) > audit→SIEM export (Stage 4) > SAML (Stage 5a) >
durable-store/HA (Stage 5c)**.

## Goals / non-goals

**Goals:** federate login to the org's single-tenant OIDC IdP via the device flow; JIT-provision a
seat keyed to a stable, non-secret, issuer-scoped `externalId` (`iss#sub`); fail closed everywhere;
RS256/JWKS verification with **zero new dependencies**; an immediate admin deprovision path.

**Non-goals (sequenced later, and honest about it):** SCIM auto-provisioning (Stage 3); SIEM/audit
**export** (Stage 4 — Stage 2 only *appends* login events, it makes no SIEM-readiness claim); SAML
(5a); secrets-at-rest encryption of `credentials.json`/`users.json` (5b); Postgres/HA (5c);
multi-tenant issuers (rejected at load).

## Architecture — model B (seat key as the durable bearer)

The ID token is a **one-time provisioning artifact**, not a per-request credential. This is what makes
headless work and keeps the long-lived replayable secret a *server-minted, disableable* seat key
rather than a stealable `id_token`.

```
1. Client startup: GET /v1/whoami → 401 (backend locked because ADA_OIDC_ISSUER is set).
2. Client GET /v1/auth/methods (unauth) → { methods:["oidc"], oidc:{ issuer, clientId,
   deviceAuthEndpoint, tokenEndpoint, scope, exchangePath } }.   ← client needs NO OIDC env of its own
3. `ada login oidc` runs the device flow against the IdP (browser; MFA/conditional-access enforced
   BY the IdP). Gets { id_token, access_token, ... }.
4. Client POST {exchangePath}  Authorization: Bearer <id_token>
      backend: verifyOidcToken → isProvisionAllowed (group/domain) → upsertSeatForSSO(iss#sub)
               → audit sso_login → 200 { seat_key: "ada_sk_…", user, role }
      client: store the SEAT KEY under the "oidc" credential (not the id_token).
5. Every later request (chat/embeddings/models/whoami, and ALL of -p / serve / acp) sends the
   ada_sk_ seat key through the hardened identifySeat hot path. No per-request JWKS/RSA, no network.
6. Offboarding: admin POST /v1/users/disable-by-external { externalId } → next request 401; re-login
   refused (disabled seat is never resurrected).
```

## Files, endpoints, env

**New** `src/server/oidc.ts` (stdlib-only): `oidcEnabled()`, `oidcConfig()` (validates + fails closed),
`assertOidcConfig()` (startup abort), `discover()` (cached openid-configuration), `verifyOidcToken()`
(RS256/JWKS with a `getKey`/`now` seam for tests), `isProvisionAllowed()`, `mapIdentityToSeatFields()`.

**Changed** `src/server/enterprise.ts`: `Seat` gains `externalId?`/`iss?`; `seatByExternalId()`,
`upsertSeatForSSO()`, `disableSeatByExternalId()`. `index.ts`: `locked() += oidcEnabled()`; `identify()`
skips GitHub/Google when OIDC is on; pre-auth `GET /v1/auth/methods` + `POST /v1/auth/oidc/exchange`;
admin `POST /v1/users/disable-by-external`; startup `assertOidcConfig()`. `oauth.ts`: `deviceGrant()`
(returns the raw token response incl. `id_token`); `deviceLogin()` builds on it. `cli.ts`:
`identityToken()` returns the OIDC seat key; `oidcLogin()` + `ensureAuth()` self-configure from
`/v1/auth/methods`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /v1/auth/methods` | none | advertise enabled login methods + public OIDC endpoints |
| `POST /v1/auth/oidc/exchange` | Bearer = `id_token` | verify → provision → return a seat key (once). The ONLY JWT entry point. |
| `POST /v1/users/disable-by-external` | admin | immediate offboarding by `iss#sub` |

| Env | Purpose | Gate |
|---|---|---|
| `ADA_OIDC_ISSUER` | master opt-in; `iss` + discovery. **https, single-tenant only.** | unset ⇒ inert; multi-tenant ⇒ refuse start |
| `ADA_OIDC_CLIENT_ID` | device-flow app id; expected `aud`/`azp` | required with issuer |
| `ADA_OIDC_ALLOWED_GROUPS` | groups permitted to provision | **unset + no domains ⇒ refuse start** |
| `ADA_OIDC_ALLOWED_DOMAINS` | alt allow-surface (email domains) | — |
| `ADA_OIDC_ADMIN_GROUP` | group ⇒ `role:"admin"` | unset ⇒ all `dev` |
| `ADA_OIDC_GROUP_CLAIM` / `ADA_OIDC_NAME_CLAIM` | claim names | `groups` / email→preferred_username→sub |
| `ADA_OIDC_JWKS_URI` / `ADA_OIDC_AUDIENCE` / `ADA_OIDC_CLOCK_SKEW_MS` / `ADA_OIDC_SCOPE` | overrides | discovered / =client id / 120000 / `openid profile email` |

## Security model — the fail-closed points (each resolves a red-team finding)

- **Backend locks on OIDC.** `locked()` includes `oidcEnabled()`, so a fresh SSO deployment with zero
  seats never falls to the dev-open `{user:"dev"}` branch. *(Fails closed at `locked()`.)*
- **No open provisioning.** `isProvisionAllowed()` requires a **positive** group/domain match, and the
  server **refuses to start** without an allow-surface — a public issuer can't JIT a seat for every
  account it will sign a token for. Domain matches require a **verified** email (`email_verified:true`
  in the token) so a self-service IdP can't provision an unverified `attacker@corp.com`; IdPs that omit
  the claim must use a group allowlist. *(Fails closed at startup + per exchange.)*
- **Legacy shared keys refused under SSO.** `ADA_CLIENT_KEYS` is ignored whenever OIDC is on (single
  identity authority), so a still-configured shared key can't bypass verification before the first
  seat is minted.
- **Issuer-scoped identity.** `externalId = iss#sub`; multi-tenant issuers rejected at load — a reused
  `sub` across tenants can't collapse two people onto one seat. *(Fails closed at config load.)*
- **Immediate, demonstrable deprovisioning.** Model B + `disableSeatByExternalId` +
  `/v1/users/disable-by-external`: a disabled seat 401s on the next request and re-login is refused,
  independent of token lifetime. *(Fails closed in `identifySeat`/`upsertSeatForSSO`.)*
- **One JWT entry point.** The `id_token` is accepted only at `/v1/auth/oidc/exchange`; it never
  reaches the per-request identity path, so it can't be forwarded to GitHub/Google verification.
- **Verifier hardening.** `alg` allowlisted to RS256 (rejects `none`/`HS*` key-confusion); `aud` must
  include the client id; `azp` (when present) must equal the client id, and a multi-audience token
  without `azp` is rejected; `exp`/`nbf`/`iat` checked with bounded skew. JWKS fetches are rate-capped
  (≤1 refetch/60s) so an attacker-chosen `kid` can't amplify fetches; `jwks_uri` must be https and is
  blocked from loopback/private hosts (a lightweight SSRF guard — origin is not pinned to the issuer
  because Google Workspace serves JWKS from a different origin).
- **One identity authority.** GitHub/Google login is disabled while OIDC is on, so a person disabled
  in the IdP can't re-enter via a still-allowed GitHub account. Admin role is downgraded to dev on a
  login that no longer carries the admin group (privilege revocation); escalation stays an explicit
  admin action.

## Verification

`npm run typecheck` + `npm run selfcheck` (hermetic: JIT mint/reuse/no-escalation, immediate
deprovision-by-externalId, prototype-safe scan, and a full RS256 verify test with a local keypair +
injected JWKS covering tamper/wrong-aud/`alg=none`/expiry → all `null`). Live-verified: OIDC-locked
backend 401s a tokenless request, fail-closed startup on missing allow-surface and multi-tenant
issuer, real-Google discovery + JWKS guard, exchange rejects a bogus token.

## Roadmap

- **Stage 3 — SCIM 2.0**: admin-gated `/scim/v2/Users` driving `createSeat`/`disableSeatByExternalId`
  on the `iss#sub` index shipped here (no migration). Automates joiner/mover/leaver.
- **Stage 4 — audit/usage SIEM export**: tee `appendAudit`/`appendUsage` to syslog/webhook/OTLP-JSON;
  audit hash-chain + `GET /v1/audit/verify`. Carries the Stage 2/3 `sso_*`/`scim_*` events.
- **Stage 5** — SAML (named account only); secrets-at-rest encryption; Postgres/HA at the `dataDir()`
  seam.
