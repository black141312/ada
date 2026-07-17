# Deploy the ada backend publicly (container + Better Auth)

This puts the ada-server on a public HTTPS URL that anyone **with an account** can use. Accounts are
gated by Better Auth (email + password) — the Ada desktop app already signs in against it
(Settings → Connections → Account). Your provider key (OpenRouter) stays on the server; users never see it.

> **Why a container, not Cloudflare Workers:** Better Auth uses `better-sqlite3` (a native module needing
> a filesystem), which Workers can't run. The container path keeps account sign-in. If you'd rather go
> serverless, that means dropping accounts for admin-minted `ada_sk_…` seat keys — see `wrangler.toml`.

## Env vars

Everything is in [`.env.production.example`](.env.production.example). The four that matter:

| var | value |
|-----|-------|
| `OPENROUTER_API_KEY` | your real key (the server routes models through it) |
| `BETTER_AUTH_ENABLED` | `1` |
| `BETTER_AUTH_SECRET` | the generated 32-byte secret (already in the example — keep it stable) |
| `BETTER_AUTH_URL` | your public URL (set after the first deploy prints it, then redeploy) |
| `ADA_AUTH_DB` | `/data/ada-auth.db` — **must** be on the persistent volume or accounts wipe on restart |

## Railway (recommended — Dockerfile auto-detected, free HTTPS, persistent volume)

```bash
# one-time
npm i -g @railway/cli
railway login                       # opens browser — YOU authenticate

# from the cos0 repo
railway init                        # create a project
railway up                          # builds the Dockerfile and deploys

# add a persistent volume mounted at /data  (Railway dashboard → your service → Volumes → mount path /data)

# set the secrets (or paste them in the dashboard → Variables)
railway variables set OPENROUTER_API_KEY=sk-or-...
railway variables set BETTER_AUTH_ENABLED=1
railway variables set BETTER_AUTH_SECRET=<your-generated-secret>
railway variables set ADA_AUTH_DB=/data/ada-auth.db
railway variables set ADA_DATA_DIR=/data

railway domain                      # generates https://<name>.up.railway.app — copy it
railway variables set BETTER_AUTH_URL=https://<name>.up.railway.app
railway up                          # redeploy so Better Auth knows its public URL
```

Alternatives with the same Dockerfile: **Fly.io** (`fly launch` → add a volume for `/data`),
**Render** (New → Web Service → Docker; add a Disk mounted at `/data`; note free tier spins down when idle).

## ⚠️ Required once: migrate the accounts database

Better Auth's tables (`user`, `session`, `account`, …) do **not** exist in a fresh `ada-auth.db`, and cos0
has no auto-migration. Until you run this, **every sign-up returns HTTP 500** (`no such table: user`).
Run it once against the deployed database (the file at `ADA_AUTH_DB=/data/ada-auth.db`):

```bash
# On the host, with the same ADA_AUTH_DB the server uses. Examples:
#   Railway:  railway run -- npx --yes @better-auth/cli@latest migrate --config src/server/auth.ts -y
#   Fly.io:   fly ssh console -C "npx --yes @better-auth/cli@latest migrate --config src/server/auth.ts -y"
#   VPS:      ADA_AUTH_DB=/data/ada-auth.db npx --yes @better-auth/cli@latest migrate --config src/server/auth.ts -y
```

The DB is on the persistent `/data` volume, so this survives restarts — you only run it again if the
auth schema changes. (Verified locally: after migrating, sign-up returns 200 and sign-in returns a token;
before it, 500.)

> Want this automatic instead of a manual step? I can make the server run the migration on startup so a
> fresh container self-heals — say the word and I'll wire it into cos0's entrypoint.

## Verify

```bash
curl https://<your-url>/health                       # {"ok":true,...}
# create an account:
curl -X POST https://<your-url>/api/auth/sign-up/email \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"a-strong-password","name":"You"}'
# an unauthenticated model call should now be REFUSED (auth is gating the backend).
```

## Point the app at it

In the Ada app → **Settings → Connections**:
- **Backend URL** = `https://<your-url>/v1`
- **Account** → sign in with the email/password you created above.

To make this the default for everyone (so a fresh install points at your server), change `backendUrl`
in `ada-app/src/app.js` (the `DEFAULTS` object) and cut a new release. Tell me the URL and I'll wire it.

## Costs & safety

- Container host: roughly $5/mo (Railway/Fly) or free-with-idle-spindown (Render).
- **Provider spend is the real cost:** every user's chats bill your OpenRouter key. Better Auth limits it
  to people with accounts, but if you expose sign-up publicly, anyone can register. For a controlled
  rollout, keep the URL private and share it only with intended users, or disable open sign-up later.
