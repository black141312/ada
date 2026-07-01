# Changelog

All notable changes to ada are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

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
