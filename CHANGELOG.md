# Changelog

All notable changes to ada are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [0.7.0] — 2026-07-02

### Added — enterprise control plane (Stage 1)
`ada-server` now doubles as an org control plane. **Enterprise mode activates only when a seat
exists or `ADA_ADMIN_KEY` is set** — with neither, nothing changes. See
[docs/enterprise.md](docs/enterprise.md).

- **Seats** — per-user client keys (`POST/GET/DELETE /v1/users`, admin-gated; keys shown once,
  listed only as prefixes; disable keeps the audit trail). `ADA_ADMIN_KEY` bootstraps the first
  admin. `/v1/whoami` now reports `{user, role}`.
- **Org policy** (`GET/PUT /v1/policy`) — a model allowlist enforced **server-side** (403 + audit),
  and tool permission rules **pushed to clients**, merged restrictive-wins with local config (org
  deny beats local allow; org can tighten, never loosen). Applied in every client path:
  interactive, `-p` headless, `serve`, `acp`.
- **Usage metering** (`GET /v1/usage?days=N`) — per-user/per-model token counts captured
  server-side by teeing each chat response and recording the upstream's reported usage (works for
  streamed and non-streamed, all adapters, one code path).
- **Audit log** (`GET /v1/audit`) — seat lifecycle, policy updates, policy denials.
- File-backed under `~/.ada/server` (`ADA_DATA_DIR` to move) — a database is the upgrade path.

Live-verified end-to-end: bootstrap → seat create → 401/403 gating → model-allowlist denial
(audited) → allowed chat metered per user → org `web_* deny` blocking a tool inside a headless run.

## [0.6.1] — 2026-07-02

### Fixed
- **Windows: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" noise on exit.** Two causes,
  both fixed: the backend health probe's undici (fetch) keep-alive socket lingered into process
  teardown — the probe now uses plain `node:http` with `agent: false` (socket closes with the
  response; verified deterministic: 3× asserting before, 0× after, on both the probe-only and the
  autostart-spawn paths); and node-pty's native module was loaded at import time by every command —
  it now loads lazily on the first `bash` call, so `--version`, `catalog`, `--list-models`, etc.
  never touch it.

[0.6.1]: https://github.com/black141312/ada/releases/tag/v0.6.1

## [0.6.0] — 2026-07-02

### Added
- **`codebase_search` — @codebase semantic search.** A read-only tool that finds code by what it
  *does*, not by exact strings ("where do we handle auth?"). Chunks the working tree (80-line
  windows, char-capped for minified files), embeds through the backend's new `/v1/embeddings`
  (forwarded to Ollama — `ollama pull nomic-embed-text`, or set `ADA_EMBED_MODEL`), caches vectors
  in `.ada/index.json` keyed by content hash (incremental — only changed files re-embed; the cache
  key includes the embedding scheme so a model/prefix change rebuilds), and ranks by cosine.
  nomic models get the asymmetric `search_query:`/`search_document:` prefixes, which measurably
  improved code-vs-prose ranking in live tests. Backend `/v1/embeddings` endpoint by @black141312.

[0.6.0]: https://github.com/black141312/ada/releases/tag/v0.6.0

## [0.5.0] — 2026-07-02

The "do it all" gap batch — everything flagged as missing after 0.4.0.

### Added
- **`ada --version` / `-v`** — prints the version and exits. (Previously it fell through to
  interactive mode and even auto-started the backend.)
- **Session API completions** for IDE panels:
  - `POST /v1/sessions/:id/abort` — the "stop generating" button; also denies any approval the turn
    was parked on so it can't stay stuck.
  - **Busy guard** — a second `prompt` on a session with a turn running gets `409` instead of
    silently interleaving two turns into one conversation.
  - `PATCH /v1/sessions/:id {"mode":"ask"|"plan"|"auto"}` — switch the permission mode live.
  - `POST /v1/sessions/:id/steer` — queue a mid-turn user message (parity with the CLI's
    type-while-running steering).
  - `images` on `prompt` — attach data:/https: image URLs to a message.
  - SDK: `session.abort()`, `.steer()`, `.setMode()`, `prompt(…, { images })`.
- **Copilot token exchange** — set `COPILOT_GITHUB_TOKEN` and the backend exchanges it at
  `/copilot_internal/v2/token`, caching + refreshing the bearer (still needs a Copilot subscription
  to exercise; `COPILOT_API_KEY` continues to work as a direct bearer). Editor-identification
  headers now report the real ada version.
- **ACP bridge streaming** — `ada acp` now emits `session/update` notifications
  (`agent_message_chunk`, `tool_call`/`tool_call_update`) while a turn runs, matching the shape ACP
  editors render live. Still experimental until exercised against a real ACP client.
- **Windows CI job** — typecheck + selfcheck now also run on `windows-latest`, exercising the
  node-pty native build on the platform many users actually run.
- **Monthly catalog refresh** — a scheduled workflow re-snapshots the models.dev catalog and opens a
  PR when prices/models changed. (Needs the "Allow GitHub Actions to create and approve pull
  requests" repo setting.)

### Fixed
- **Skill auto-apply false positives** — a long conversational sentence merely *containing* a
  skill-y keyword ("remember this: the secret word is…" → `secret-scan`, observed live) no longer
  auto-applies. New coverage gate: at least a third of the query's content tokens must match the
  skill; short task-like commands ("describe the project") still fire.

### Security
- SECURITY.md now states plainly that `ada serve` has no auth of its own — keep it on localhost or
  front it with an authenticating proxy.

### Hardening (from a pre-merge adversarial review of this batch; all verified live)
- A client that dies **mid-request-body** (e.g. a dropped image upload) no longer bricks the session
  with a permanent 409 — the claim is released on `req` close.
- A client that **drops the SSE stream mid-turn** (IDE reload/crash) no longer leaves the turn
  running headless (or, in ask mode, parked forever on an approval nobody can see) — the turn is
  aborted on `res` close.
- The skill-router coverage gate counts **exact** token matches with a **strict** threshold — the
  prefix-matching + inclusive-bound combination re-admitted short phrasings of the very leak the
  gate was built to stop.
- Copilot: `COPILOT_GITHUB_TOKEN` alone now actually configures the provider (the exchange was
  unreachable), stored credentials again send an auth header, and an upstream 401 invalidates the
  cached bearer.
- Resuming a transcript that a live session is still writing is refused (409 + the live sessionId)
  instead of interleaving two conversations into one file.
- `tool_call`/`tool_result` events carry a stable `callId` (generated when a backend omits streamed
  ids); ACP gained `session/cancel`; SDK `abort()` surfaces HTTP errors instead of pretending success.

[0.5.0]: https://github.com/black141312/ada/releases/tag/v0.5.0

## [0.4.0] — 2026-07-01

### Added
- **Interactive agent sessions on `ada serve`** — the integration point for building a Cursor-style
  agent panel into your own IDE, from any language, over HTTP + Server-Sent Events:
  `POST /v1/sessions` → persistent session, `POST /v1/sessions/:id/prompt` → streamed
  `text`/`tool_call`/`tool_result`/`approval_request`/`done` events, `POST /v1/sessions/:id/approve`
  to answer a pending approval from your own UI, `DELETE /v1/sessions/:id` to free it. Sessions
  default to real approval gating (`autoApprove: false`) — edits pause until you decide, they never
  auto-run silently.
- `Agent.send()` gained an `onEvent` option (`AgentEvent`: text/tool_call/tool_result/done) — the
  structured alternative to writing ANSI text to stdout, additive and opt-in (existing CLI/TUI
  behavior is unchanged when it isn't set).
- The typed SDK (`src/sdk`) gained `ada.session()` — a small wrapper around the above (manual SSE
  parsing, no dependency) with `.prompt(text, onEvent)`, `.approve(id, decision)`, `.close()`.
- `src/client/agent-server.ts` — the pure, unit-tested helpers behind the session endpoints
  (SSE framing, id generation, approval correlation).
- **Session resume across an `ada serve` restart.** `GET /v1/sessions` lists on-disk transcripts;
  `POST /v1/sessions` accepts `{ resume: "latest" | "<file>" }` to reattach a fresh in-memory Agent
  to an existing one, replaying its history so the conversation continues where it left off even
  after the server process died and restarted. SDK: `ada.listSessions()`, `ada.session({ resume })`.

Verified live end-to-end against a local Ollama model: session create → tool_call →
approval_request → approve → tool_result → done, with the file actually written only after approval.
Resume verified by killing and restarting the `ada serve` process mid-conversation (a fresh,
empty in-memory session map) and confirming the model still recalled a fact from before the restart.

[0.4.0]: https://github.com/black141312/ada/releases/tag/v0.4.0

## [0.3.1] — 2026-06-30

### Fixed
- `npx ada-agent` failed with "could not determine executable to run" — the package has two bins
  (`ada`, `ada-server`) and neither matched the package name after the rename. Added an `ada-agent`
  bin alias (→ the client) so `npx ada-agent` and `npm i -g ada-agent && ada-agent` work as documented.

[0.3.1]: https://github.com/black141312/ada/releases/tag/v0.3.1

## [0.3.0] — 2026-06-30

### Added
- **Auto-start the backend** — `ada` now spawns `ada-server` as a child process if it isn't already
  reachable. Solo users no longer need two terminals. `ADA_BACKEND_URL` pointing at a remote URL
  skips the auto-start; `ADA_NO_AUTOSTART=1` opts out. Backend-free subcommands
  (`mcp`/`skill`/`worktree`/`catalog`/`share`) don't trigger it either.
- **`.github/workflows/release.yml`** — auto-publish `ada-agent` to npm on a `v*` tag push, with a
  tag-vs-`package.json` safety check + provenance attestation. The CONTRIBUTING release flow is
  documented.

[0.3.0]: https://github.com/black141312/ada/releases/tag/v0.3.0

## [0.2.0] — 2026-06-30

### Added
- **Cloudflare** provider (Workers AI + AI Gateway, OpenAI-compatible) — env-overridable URL covers
  both endpoints. New `@cf/*` router rule. `@cf/moonshotai/kimi-k2.7-code` is now runnable.
- **`groq/<model>`** and **`together/<model>`** routing prefixes — disambiguate shared model names
  (`llama-3.3`, `gemma2`) that no prefix can.
- **Curated offline model catalog** snapshotted from models.dev (12 providers, 672 models) — baked
  `src/client/catalog.json`, used as the offline seed for pricing/limits. Maintained via
  `npm run catalog:refresh`. New `ada catalog [provider]` subcommand + `/catalog` REPL command.
- **`bench/swebench.mjs`** — SWE-bench Verified prediction generator driven by ada (resumable,
  concurrent, isolated repo clones); scoring stays with the official `swebench` Docker harness.
- **`docs/cloudflare.md`** — Workers AI + AI Gateway step-by-step.

### Changed
- npm package renamed to unscoped **`ada-agent`** (`npx ada-agent`, `npm i -g ada-agent`); the CLI
  command stays `ada`. (`ada` / `ada-code` were taken/blocked on npm.)
- Generalized the OpenAI-compat adapter's model-prefix strip (handles `copilot/` / `groq/` /
  `together/`); `@cf/…` passes through as-is.
- Architecture diagram refreshed (richer client card, full provider list); docs refreshed
  (architecture / integrations / connectors).

[0.2.0]: https://github.com/black141312/ada/releases/tag/v0.2.0

## [0.1.0] — 2026-06-30

First public release. ada is a from-zero terminal coding agent: a key-holding **routing backend**
(OpenAI Chat Completions in, every provider out) plus a thin **terminal client** — run through `tsx`,
no build step.

### Core
- Agentic loop with streaming, parallel read-only tools, and leaked-tool-call recovery for weaker models.
- Providers: OpenAI, Anthropic, Google Gemini, Mistral, Groq, DeepSeek, Together, xAI, DashScope,
  OpenRouter, and local Ollama — routed by model id; a new OpenAI-compatible provider is two lines.
- Tools: `read_file`, `write_file`, `edit_file`, `apply_patch` (multi-file), `bash` (real PTY via
  node-pty), `ls`, `glob`, `grep` (ripgrep fast-path), `web_fetch`/`web_search` (SSRF-guarded),
  `lsp_diagnostics`, `ask_user`, `spawn_agent`, `background_task`.
- Sessions (persisted, `--continue`/`--resume`), automatic context compaction, checkpoint/undo,
  git worktrees, workspace snapshots (`/snapshot` `/restore`), named agents.

### Skills & orchestration
- ~285 built-in skills with progressive disclosure (`list_skills`/`find_skill`/`use_skill`) and a
  relevance router that **auto-applies** a clearly-matching skill (precision-guarded against lexical
  false positives).
- Pluggable orchestration strategies: `react`, `single`, `plan`, `multi`, `toolsmith`.

### Connectors & integrations
- MCP connectors over stdio and Streamable HTTP, a curated catalog + `ada mcp` CLI, and resources.
- HTTP API (`ada serve`), a typed SDK (`src/sdk`), an ACP bridge (`ada acp`), and local session
  sharing (`ada share`). models.dev pricing/limits; a GitHub Copilot provider scaffold.

### Experience
- Permission modes — `/ask`, `/plan`, `/auto` (`/mode` to cycle), with plain-words approval prompts.
- Auto-format on edit (trusted projects), readline REPL and an inline TUI (`--tui`), GitHub/Google
  device-flow login, extensions (tools + hooks + commands), and prompt templates.

[0.1.0]: https://github.com/black141312/ada/releases/tag/v0.1.0
