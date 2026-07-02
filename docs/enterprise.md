# Enterprise: seats, policy, metering, audit

`ada-server` doubles as an org **control plane**: per-user seat keys, an org policy the backend
enforces (and clients apply locally), per-user usage metering, and an audit log. It's all
file-backed under `~/.ada/server/` (override with `ADA_DATA_DIR`) — fine to ~50 seats; a database
is the upgrade path, not the starting point.

**Enterprise mode activates only when a seat exists or `ADA_ADMIN_KEY` is set.** With neither, the
backend behaves exactly as before (dev-open, or `ADA_CLIENT_KEYS`/login).

## Bootstrap (2 minutes)

```bash
# 1. start the backend with a bootstrap admin key (any long random string)
export ADA_ADMIN_KEY=$(openssl rand -hex 24)
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...     # your provider keys
ada-server                     # banner shows: [ENTERPRISE (0 seats + admin key)]

# 2. create a seat per developer — the key is shown ONCE
curl -s -X POST -H "Authorization: Bearer $ADA_ADMIN_KEY" \
     -d '{"name":"alice"}' http://localhost:8787/v1/users
# → { "key": "ada_sk_…", "name": "alice", "role": "dev", "note": "shown once — store it now" }
```

Each developer sets their seat key and points at the backend:

```bash
export ADA_BACKEND_URL=https://ada.yourcompany.com/v1
export ADA_CLIENT_KEY=ada_sk_…
ada
```

## Seats

```bash
GET    /v1/users               # list: name, role, keyPrefix, created, disabled   (admin)
POST   /v1/users               # {"name":"bob","role":"dev"|"admin"} → full key, once   (admin)
DELETE /v1/users/<keyPrefix>   # disable a seat (≥12 chars of its key; kept for the audit trail)   (admin)
```

Full keys are never listed after creation — only a 14-char prefix. `ADA_ADMIN_KEY` is the
break-glass admin; create an admin *seat* for day-to-day and keep the env key in a vault.

## SSO (OIDC) — federate login to your IdP

Instead of handing out static seat keys, connect your OIDC IdP (Okta, Entra **single-tenant**, Auth0,
Keycloak, Google Workspace). Developers sign in through the browser via the device flow, and the
backend **JIT-provisions a seat** for the verified identity. Seats are keyed to a stable, non-secret
`iss#sub`, so offboarding has a target.

```bash
# On the backend (all values are non-secret except any confidential-client secret):
export ADA_OIDC_ISSUER=https://your-tenant.okta.com          # single-tenant issuer URL (https)
export ADA_OIDC_CLIENT_ID=<device-flow app client id>
export ADA_OIDC_ALLOWED_GROUPS=ada-users                     # OR ADA_OIDC_ALLOWED_DOMAINS=yourco.com
export ADA_OIDC_ADMIN_GROUP=ada-admins                       # optional: this group → role "admin"
ada-server                                                   # banner: [OIDC SSO (0 seats — awaiting first login)]
```

**Setting `ADA_OIDC_ISSUER` locks the backend immediately** (before any seat exists) — a request
that doesn't authenticate gets `401`, never dev-open. Two fail-closed guards refuse to start on unsafe
config: no `ALLOWED_GROUPS`/`ALLOWED_DOMAINS` (would provision every IdP user), or a **multi-tenant**
issuer (`.../common` or `.../organizations`, where `sub` isn't unique). When OIDC is on, the
GitHub/Google login path is disabled — the IdP is the single identity authority.

The developer needs **no OIDC config** — the client learns it from the backend:

```bash
export ADA_BACKEND_URL=https://ada.yourcompany.com/v1
ada login oidc     # opens the IdP in a browser; on success stores a seat key. Then just `ada`.
```

Under the hood the ID token is a **one-time provisioning artifact**: `ada login oidc` exchanges it at
`POST /v1/auth/oidc/exchange` for a durable `ada_sk_` seat key, and every later request (including
`-p`, `serve`, `acp`) carries that seat key — so long headless runs never expire mid-job, and
revocation is a seat-disable, not a token-lifetime wait.

**Offboarding (immediate):** disable the seat by its `iss#sub`. The next request 401s and re-login is
refused (a disabled seat is never resurrected).

```bash
curl -X POST -H "Authorization: Bearer $ADA_ADMIN_KEY" \
     -d '{"externalId":"https://your-tenant.okta.com#00u1a2b3c4"}' \
     http://localhost:8787/v1/users/disable-by-external
```

`GET /v1/auth/methods` (unauthenticated) advertises the enabled methods. ID-token verification is
stdlib-only (RS256 + JWKS, `alg` allowlisted, `iss`/`aud`/`azp`/`exp`/`nbf` checked) — no new
dependency. Full env reference and the security model: [enterprise-stage2-oidc.md](enterprise-stage2-oidc.md).

Automated joiner/mover/leaver (**SCIM**) and audit **export to a SIEM** are the sequenced next stages;
today login events (`sso_login`, `sso_login_denied`, `seat_created`, `seat_disabled`) are appended to
the audit log but not yet streamed out.

## Org policy

```bash
curl -X PUT -H "Authorization: Bearer $ADA_ADMIN_KEY" http://localhost:8787/v1/policy -d '{
  "models": ["@cf/*", "claude-*"],
  "permissions": [
    { "tool": "web_*",  "action": "deny" },
    { "tool": "bash",   "pattern": "*curl*", "action": "ask" }
  ]
}'
```

- **`models`** — allowlist (`*` wildcards). Enforced **server-side** (403 + audit entry), so a
  modified client can't route around it. Empty/absent = all models.
- **`permissions`** — tool rules **pushed to clients** (fetched from `GET /v1/policy` at startup —
  interactive, `-p` headless, `serve`, and `acp` alike). Merged restrictive-wins with local config:
  an org `deny` beats any local `allow`, an org `ask` upgrades a local `allow`, and an org `allow`
  can never *loosen* a local deny or the default gating. **Honest caveat:** tool rules run in the
  *client*, so they govern well-behaved clients — and only **model-allowlist** denials are audited
  server-side; tool-rule outcomes are not visible to `/v1/audit`. The **hard, server-enforced**
  guarantees are: authentication, the model allowlist, provider pinning (when an allowlist is set,
  the client's `provider` hint is ignored so a request can't be re-routed off-policy), and metering.

## Usage & audit

```bash
GET /v1/usage?days=30    # totals + per-user + per-model {requests, promptTokens, completionTokens}   (admin)
GET /v1/audit?limit=200  # seat_created / seat_disabled / policy_updated / policy_denied_model …      (admin)
```

Metering is captured server-side by teeing every chat response (streamed or not) and recording the
upstream's reported token usage per user — clients can't underreport. Join with
`ada catalog` prices for cost.

## Deployment notes

- Run behind TLS (caddy/nginx) — seat keys travel as bearer tokens.
- `ADA_DATA_DIR` on a persistent volume; back it up (it's 4 small JSON/JSONL files).
- One deployment = one org. Multi-org/SaaS is deliberately out of scope for v1.
- Compliance paperwork (SOC 2, DPA) is process, not code — start it when a buyer asks.
