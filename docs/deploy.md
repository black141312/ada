# Deploying ada-server

`ada-server` is the routing backend — it holds provider keys and speaks the OpenAI-compatible API
that every ada client (the `ada` CLI **and** the ada IDE) points at. It's a small Node HTTP server;
this guide runs it in a container. Clients then set `ADA_BACKEND_URL` (CLI) or `ada.backendUrl` (IDE)
to its URL.

## Quick start (container)

```bash
cp .env.example .env          # add at least one provider key (see below)
docker compose up --build     # → http://localhost:8787

# point a client at it
ADA_BACKEND_URL=http://localhost:8787/v1 ada
```

Or without compose:

```bash
docker build -t ada-server .
docker run -p 8787:8787 -v ada-data:/data --env-file .env ada-server
```

The image is **server-only** (~small, `node:22-slim`, no native build) — it drops the `node-pty`
client tool and the `skills/` bundle it doesn't need.

## Configuration (env)

| Var | Purpose |
|---|---|
| provider keys | e.g. `CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … — set what you use. Every provider + its key env is in [`src/server/config.ts`](../src/server/config.ts). |
| `ADA_PORT` | listen port (default `8787`). |
| `ADA_DATA_DIR` | where seats/policy/usage/audit live (default `/data` in the image). **Mount a volume here** — see persistence. |
| `ADA_ADMIN_KEY` | bootstrap admin key → enables the enterprise control plane ([enterprise.md](enterprise.md)). |
| `ADA_OIDC_*` | OIDC SSO ([enterprise-stage2-oidc.md](enterprise-stage2-oidc.md)). |

## Persistence — mount `/data`

The stores are flat JSON/JSONL under `ADA_DATA_DIR`. In a container that directory is **ephemeral**
unless you mount a volume — without one, seats, usage, and the audit log are lost on restart. The
compose file and the `docker run -v ada-data:/data` above handle this. On a PaaS, attach a persistent
disk/volume mounted at `/data`.

> If your platform has no persistent volume (e.g. plain Cloudflare Workers), that's the signal to move
> to the Workers + D1/KV port below rather than the container.

## Cloudflare

Two independent things, don't conflate them:

**1. Using Cloudflare's models (no code, works today).** Set `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_API_TOKEN` and request `@cf/*` model ids (e.g. `@cf/meta/llama-3.3-70b-instruct`) — the
router sends them to Workers AI. To route *all* providers through a **Cloudflare AI Gateway** (for
unified logging, caching, rate-limiting), point `CLOUDFLARE_BASE_URL` at your gateway URL.

**2. Hosting the container.**
- **Easiest durable path (recommended now):** any container host with a persistent volume — **Fly.io**,
  **Render**, **Railway**. Deploy the Dockerfile, attach a volume at `/data`, set env, done. Put TLS
  in front (the platform usually does this for you).
- **Cloudflare Containers** (beta): runnable via a Worker + container binding, but Cloudflare's model
  is stateless-leaning — durable seat/usage/audit state wants **R2/D1**, not a container disk. For a
  Cloudflare-native, stateful deploy, prefer the port below.

### Cloudflare Worker (edge-native) — `src/worker/`

An edge-native port of the backend ships in `src/worker/` (config: `wrangler.toml`, schema:
`src/worker/schema.sql`). It's a self-contained Workers `fetch` handler: auth (D1 seats + admin key),
the org model-allowlist, and provider passthrough with server-side metering — **Cloudflare Workers AI
(`@cf/*`) is the first-class provider**. Use *either* this Worker *or* the container, not both.

```bash
npx wrangler d1 create ada                                   # → paste the id into wrangler.toml
npx wrangler d1 execute ada --file src/worker/schema.sql --remote
npx wrangler secret put ADA_ADMIN_KEY                        # bootstrap admin
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID                # for @cf/* Workers AI models
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
# then create seats: curl -X POST -H "Authorization: Bearer $ADA_ADMIN_KEY" -d '{"name":"alice"}' https://<worker>/v1/users
```

Endpoints match the Node backend (`/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, and the
admin `/v1/users` · `/v1/policy` · `/v1/usage` · `/v1/audit`). Stores are strongly-consistent **D1**.

**Deferred to a follow-up** (the Worker returns a clear error meanwhile): **native Anthropic** — reach
Claude via OpenRouter (`anthropic/claude-…`) or point `CLOUDFLARE_BASE_URL` at an AI Gateway; and
**OIDC SSO**, which needs a Web Crypto port of `oidc.ts` (`node:crypto`/`node:net` aren't on Workers).
Metering is a `TransformStream` tee today; an **AI Gateway** in front gives it to you for free.

## Hardening

- Terminate **TLS** in front (Caddy/nginx, or the PaaS) — seat keys travel as bearer tokens.
- Back up the `/data` volume (four small files).
- Lock it down: set `ADA_ADMIN_KEY` or `ADA_OIDC_*` so the backend isn't dev-open (see
  [enterprise.md](enterprise.md)).
- To run non-root, add `USER node` to the Dockerfile and ensure the mounted volume is writable by
  uid 1000.
