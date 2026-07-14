# Host ada-server on Cloudflare Workers, and point ada-ide at it

This is the **hosted** setup: you run `ada-server` on Cloudflare's edge (it holds the provider keys,
authenticates users, routes + meters requests). Each user's IDE still runs the agent **locally** —
the agent's tools and skills operate on the user's own files, so they can't run on the edge. The
Worker is the key-custody + routing + auth layer only.

```
user's ada-ide  ──spawns──▶  ada serve (local: agent + tools + skills)  ──routes──▶  your Worker  ──▶  OpenRouter
   (no keys)                  (skills come via `npx ada-agent`, no install)          (holds keys, seats)
```

## 1 · Deploy the Worker

From the repo root (needs a Cloudflare account; `npx wrangler login` once):

```bash
npx wrangler d1 create ada                       # copy the database_id → wrangler.toml [[d1_databases]]
npx wrangler d1 execute ada --file src/worker/schema.sql --remote
npx wrangler secret put ADA_ADMIN_KEY            # any long random string — your admin bootstrap
npx wrangler secret put OPENROUTER_API_KEY       # the provider you route through
npx wrangler deploy                              # prints https://ada-server.<your-subdomain>.workers.dev
```

The Worker is **always locked** — every request needs a valid seat key or the admin key (no dev-open
mode), so it's safe to expose publicly. (Optional: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
secrets to also serve Cloudflare Workers AI `@cf/*` models.)

> The Worker port reaches Claude/GPT/Gemini/… **via OpenRouter** (model ids like
> `anthropic/claude-opus-4.8`). Native Anthropic and OIDC SSO aren't on the Worker yet — use the
> container backend (`Dockerfile`) if you need those.

## 2 · Mint a seat key per user

```bash
curl -X POST https://ada-server.<sub>.workers.dev/v1/users \
  -H "authorization: Bearer $ADA_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"alice","role":"dev"}'
# → { "key": "ada_sk_…", ... }   (shown once — hand it to that user)
```

Revoke with `DELETE /v1/users/<name>`. Set an org model-allowlist with `PUT /v1/policy` (admin only).

## 3 · Point ada-ide at it

In ada-ide → Settings → search **Ada** (or `settings.json`):

| Setting | Value |
|---|---|
| `ada.backendUrl` | `https://ada-server.<sub>.workers.dev/v1` |
| `ada.backendKey` | the user's `ada_sk_…` seat key |
| `ada.cliCommand` | leave `ada` — it auto-uses a local `ada` if installed, else `npx ada-agent` |

Open **"Open Ada Agent"** → the panel launches the agent (fetching `ada-agent` via `npx` on first
run if it isn't installed) and routes every model call through your Worker. **Skills travel with the
agent** (they ship inside the `ada-agent` package `npx` pulls) — nothing to configure.

To ship the IDE pre-connected, set the `ada.backendUrl` **default** in
`extensions/ada-agent/package.json` to your Worker URL before packaging the extension.
