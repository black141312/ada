# Changelog

All notable changes to ada are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

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
