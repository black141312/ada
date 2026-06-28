# ada

A coding agent built from zero, with a **Cursor-style routing backend**.

```
 terminal client  ──▶  ada backend  ──▶  Anthropic / OpenAI / Mistral / Gemini / …
 (holds no keys)        (auth · route · normalize;        (real providers)
                         provider keys live here —
                         the one control point)
```

The client speaks only **OpenAI Chat Completions** to the backend. The backend routes each
request to the right provider and normalizes every provider back to that one format.

## Run

```bash
# 1) backend (holds the provider keys)
export ANTHROPIC_API_KEY=sk-ant-...     # and/or OPENAI_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY, …
npm run server                          # → http://localhost:8787

# 2) client (in another terminal)
npm start                               # pick a model, then chat
npm start -- --list-models              # list everything your keys can reach
npm start -- --continue                 # resume the last session
```

Windows: use `set VAR=value` instead of `export`.

Checks: `npm run typecheck` · `npm run selfcheck` (offline).

## Layout

```
src/
  shared/
    types.ts          shared provider/model types

  server/             the routing backend            (npm run server)
    index.ts          HTTP entry: auth → route → dispatch to an adapter
    config.ts         providers, base URLs, key env vars, port, client-key auth
    router.ts         model id → provider (prefix rules; explicit `provider` wins)
    sse.ts            Server-Sent Events helpers
    providers/
      adapter.ts      the Adapter interface          ← one adapter per WIRE FORMAT
      registry.ts     provider → adapter map         ← who shares what, at a glance
      openai-compat.ts OpenAI-compatible adapter (OpenAI, Mistral, Groq, Gemini-compat, …)
      anthropic.ts    native Anthropic adapter (lazy @anthropic-ai/sdk)

  client/             the terminal agent             (npm start)
    cli.ts            REPL: flags, model picker, approval prompt
    agent.ts          the agentic loop (stream → tool calls → feed back → repeat)
    compaction.ts     context management — summarize old turns when context grows
    tools.ts          read_file / write_file / edit_file / bash
    session.ts        append-only JSONL session store (.ada/sessions/)

  selfcheck.ts        offline checks (tools, session, routing)
```

## Design

- **One adapter per wire format, not per model or provider.** Most providers speak the
  OpenAI format and share `openai-compat.ts`; only divergent formats (Anthropic) get their own.
  So: a new model = **0 code**; a new OpenAI-compatible provider = **2 lines in `config.ts`**;
  a brand-new format = **1 adapter** + a line in `registry.ts`.
- **The backend is the one control point** — it holds every provider key and is where auth,
  rate limits, and billing belong. The client carries only a ada client key.
- **Vendor SDKs are loaded lazily** (pi-style): a `type`-only import plus a dynamic `import()`,
  so e.g. `@anthropic-ai/sdk` never loads unless a Claude request actually arrives.
- **Context management (compaction)** — the client estimates context size (chars/4) and, when it
  crosses `ADA_COMPACT_AT` (default 100k tokens) or a request overflows, summarizes older turns into
  one compact summary and keeps the recent ones. Manual `/compact`; `/context` shows the estimate.

## Roadmap

Native Google (`@google/genai`) and Mistral adapters · client-key auth + usage log · more
tools (grep, ls) · branching sessions.
