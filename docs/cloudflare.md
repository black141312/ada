# Using Cloudflare models with ada

Cloudflare gives you two OpenAI-compatible endpoints, and ada speaks OpenAI — so both are just the
`cloudflare` provider with the right env vars. Pick the one you have:

- **Workers AI** — Cloudflare *hosts* the model (Llama, Qwen, Gemma, Kimi, …). Simplest.
- **AI Gateway** — Cloudflare *proxies* other providers (OpenAI/Anthropic/Workers AI/…) through one
  endpoint, with caching + analytics + optional unified billing.

Browse what's available and its pricing any time, offline:

```bash
ada catalog cloudflare          # Workers AI + AI Gateway models, context + $/1M
```

---

## Workers AI (recommended start)

1. **Cloudflare dashboard → AI → Workers AI → "Use REST API".** Copy your **Account ID** and
   **create an API token** (Workers AI scope).
2. Set the env vars for the backend:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=your-32-char-account-id
   export CLOUDFLARE_API_TOKEN=your-workers-ai-token
   ```
3. Start the backend and run ada with a `@cf/…` model id:
   ```bash
   ada-server
   ada --model "@cf/moonshotai/kimi-k2.7-code"     # or any id from `ada catalog cloudflare`
   ```

That's it. ada routes `@cf/*` to Cloudflare automatically, sends the full id through, and `/cost`
already knows the price from the catalog.

> The default endpoint ada builds is
> `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1` — Workers AI's
> OpenAI-compatible base. No code change needed.

---

## AI Gateway

1. **Cloudflare dashboard → AI → AI Gateway → create a gateway.** Note your **Account ID** and
   **Gateway ID**, and grab the gateway's **OpenAI-compatible endpoint URL** (the "compat" base).
2. Point ada at that URL and supply the token it expects (your gateway token, or the upstream
   provider's key, depending on how the gateway is configured):
   ```bash
   export CLOUDFLARE_BASE_URL="https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat"
   export CLOUDFLARE_API_TOKEN=your-gateway-or-provider-key
   ```
   (`CLOUDFLARE_BASE_URL` overrides the Workers AI default, so `CLOUDFLARE_ACCOUNT_ID` isn't needed.)
3. Use the model id format your gateway expects (often `provider/model`, e.g. `openai/gpt-4o`), and
   route it explicitly to the `cloudflare` provider — easiest is the `--provider` field or an
   `@cf/`-style id; otherwise send `provider: "cloudflare"` on the request.

> Copy the exact base URL from your AI Gateway page — Cloudflare shows the OpenAI-compatible endpoint
> there. ada just proxies to whatever you set.

---

## How it works (why it's only ~2 lines in ada)

ada keys providers by **wire format**, not by vendor. Cloudflare's Workers AI and AI Gateway both
emit the OpenAI Chat Completions format, so they reuse the shared `openai-compat.ts` adapter — no
Cloudflare-specific SDK or adapter. The whole integration is:

- one `PROVIDERS` entry in [`src/server/config.ts`](../src/server/config.ts) (base URL + key env),
- one router line in [`src/server/router.ts`](../src/server/router.ts) (`@cf/*` → cloudflare).

(Contrast: opencode pulls in dedicated `workers-ai-provider` / `ai-gateway-provider` packages + a
custom loader, because it's built on the Vercel AI SDK's per-provider abstraction. ada doesn't need
that for an OpenAI-shaped endpoint.)

## Troubleshooting

- **401 / 403** — wrong token or scope. Workers AI needs a Workers-AI-scoped token; the Account ID
  must match the token's account.
- **404 on the model** — the `@cf/…` id isn't hosted; check `ada catalog cloudflare` or the Workers
  AI catalog in the dashboard.
- **`/cost` says "no price table"** — the model isn't in the baked catalog; run `npm run catalog:refresh`.
