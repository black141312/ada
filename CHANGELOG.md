# Changelog

All notable changes to ada are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

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
