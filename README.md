# ada

[![npm](https://img.shields.io/npm/v/ada-agent)](https://www.npmjs.com/package/ada-agent)
[![CI](https://github.com/black141312/ada/actions/workflows/ci.yml/badge.svg)](https://github.com/black141312/ada/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](package.json)

A coding agent built from zero — a terminal client in the spirit of pi / Codex / Cursor,
that holds every provider key and speaks one wire
format to the client.

![ada architecture](docs/architecture.svg)

The client talks **only** OpenAI Chat Completions to the backend. The backend routes each request
to the right provider by model id and normalizes every provider back to that one format — so a new
model is **zero code**, and a new OpenAI-compatible provider is **two lines**.

---

## Features

- **Agentic loop** — streams, calls tools, feeds results back, repeats until done.
- **Tools** — `read_file`, `write_file`, `edit_file` (exact-match), `apply_patch` (multi-file),
  `bash`, `ls`, `grep` (uses `rg` if present), `glob`, `web_fetch`, `web_search`, `lsp_diagnostics`,
  `ask_user` (clarifying questions).
- **Auto-format on edit** — written files are formatted with the project's formatter
  (prettier/gofmt/rustfmt/ruff/shfmt) in trusted projects; off via `ADA_NO_FORMAT`.
- **LSP diagnostics** — `lsp_diagnostics` runs a language server (typescript-language-server,
  pyright, gopls, rust-analyzer) and returns errors/warnings; servers are reused, trusted-project only.
- **Real PTY shell** — `bash` runs in a pseudo-terminal (node-pty), so TTY-only programs, colour, and
  progress output behave; ANSI is stripped from what the model sees.
- **Two front-ends** — a classic readline REPL and an inline **TUI** (`--tui`) with a live "thinking"
  spinner and Claude-style turn markers.
- **Permission modes — ask / plan / auto** — `/ask` confirms each tool, `/plan` is read-only (ada
  plans, `/run` to execute), `/auto` runs freely (destructive `bash` still confirms). Each approval
  states in plain words what it wants ("ada wants to run a shell command…") instead of raw args.
- **Skills that actually fire** — ~285 built-in skills; ada routes every request and **auto-applies**
  a clearly-matching one (injecting its procedure), or suggests skills to load. See [Skills](#skills).
- **todos**, **checkpoint/undo** (revert the agent's edits), **protected paths**, **git worktrees**,
  **workspace snapshots** (`/snapshot` `/restore`), **named agents**, and **subagents** (`spawn_agent`).
- **Sessions** — every turn is persisted; `--continue` / `--resume` to pick up where you left off.
- **Context compaction** — summarizes old turns automatically as context grows.
- **Sign in with GitHub or Google** (RFC 8628 device flow) — zero client config.
- **Extensible** — extensions (tools + hooks + commands), prompt templates, skills, and MCP servers.
- **No build step** — TypeScript run through `tsx`.

## Providers

The backend proxies any OpenAI-compatible upstream and translates the one that isn't (Anthropic):

| Provider | Models | Key env var |
|---|---|---|
| OpenAI | `gpt-*`, `o*` | `OPENAI_API_KEY` |
| Anthropic | `claude-*` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini-*`, `gemma-*` | `GEMINI_API_KEY` |
| Mistral | `mistral-*`, `codestral-*`, … | `MISTRAL_API_KEY` |
| DeepSeek | `deepseek-*` | `DEEPSEEK_API_KEY` |
| xAI (Grok) | `grok-*` | `XAI_API_KEY` |
| DashScope (Qwen) | `qwen-*`, `qwq-*` | `DASHSCOPE_API_KEY` |
| **Cloudflare** (Workers AI / AI Gateway) | `@cf/*` (e.g. `@cf/moonshotai/kimi-k2.7-code`) | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) |
| Groq | `groq/<model>` | `GROQ_API_KEY` |
| Together | `together/<model>` | `TOGETHER_API_KEY` |
| OpenRouter | everything else | `OPENROUTER_API_KEY` |
| **Ollama (local)** | `name:tag` (e.g. `qwen2.5-coder:latest`) | *keyless* |

Routing: a model id containing `:` → local Ollama; `@cf/*` → Cloudflare; `groq/…`/`together/…` pick
those providers (their model names — `llama-3.3`, `gemma2` — are ambiguous, so they're explicit);
otherwise by prefix; an explicit `provider`
field always wins. Set only the keys you have — the rest stay dormant (vendor SDKs load lazily).

---

## Install

Requires **Node ≥ 18** (and a C toolchain, since `node-pty` builds natively).

**Run it without installing — `npx`:**

```bash
npx ada-agent                      # the client   (published to npm)
npx -p ada-agent ada-server        # the backend  (second bin in the same package)
# straight from source, no publish needed:
npx github:black141312/ada
```

**Install globally** (puts `ada` and `ada-server` on your PATH):

```bash
npm install -g ada-agent
ada
```

**From a clone** (for hacking on it):

```bash
git clone https://github.com/black141312/ada.git
cd ada && npm install
npm link            # global `ada` / `ada-server`  ·  or `npm start`
```

> The published-npm commands work once a maintainer has run `npm publish`; the `github:` form works
> against the repo today.

## Quickstart

ada is two processes: a **backend** (holds keys, routes) and the **`ada`** client.

**Option A — local, no keys (Ollama):**

```bash
# terminal 1: backend
ada-server                              # → http://localhost:8787

# terminal 2: the agent
ada                                     # pick a local model and chat
```

**Option B — a cloud provider:**

```bash
# terminal 1
export ANTHROPIC_API_KEY=sk-ant-...     # and/or OPENAI_API_KEY, GEMINI_API_KEY, …
ada-server

# terminal 2
ada --model claude-opus-4-8
```

Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."`.

---

## Using `ada`

```bash
ada                      # interactive; pick a model on first run
ada --tui                # inline TUI front-end
ada --model <id>         # start on a specific model
ada --list-models        # everything your keys can reach (via the backend)
ada --continue           # resume the most recent session
ada --resume             # pick a session to resume
ada --yolo               # auto-approve tool calls (skip prompts)
ada -p "fix the build"   # one-shot: print the answer and exit
```

**Slash commands** (in a session): `/ask` · `/plan` · `/auto` · `/mode` (cycle the permission mode) ·
`/run` · `/model [id]` · `/models` · `/reasoning low|medium|high|off` ·
`/strategy react|single|plan|multi|toolsmith` · `/agent [name]` · `/todos` · `/undo` · `/snapshot` ·
`/restore` · `/jobs` · `/fork` · `/tree` · `/rewind` · `/compact` · `/context` · `/cost` ·
`/image <path>` · `/paste` · `/login` · `/logout` · `/exit`.

**Permission modes** — switch with `/ask` · `/plan` · `/auto` (or `/mode` to cycle); the current mode
shows in the prompt line. In **ask** mode each gated tool prompts with what it wants in plain words
(`ada wants to run a shell command…`) and one key: `[y]es` · `[a]uto` (run the rest without asking) ·
`[p]lan` · `[n]o`. **plan** is read-only — ada plans but won't edit; `/run` approves and executes.
**auto** runs tools without asking (destructive `bash` still confirms). `--yolo` starts in **auto**.

**Subcommands:** `ada mcp …` (connectors) · `ada skill add <url>` · `ada worktree add <name>` ·
`ada catalog [provider]` (offline model/price catalog) · `ada serve` (HTTP API) · `ada share`
(view a session) · `ada acp` (editor bridge). See
[docs/integrations.md](docs/integrations.md) for the HTTP API, the typed SDK, and ACP.

**Orchestration strategies** — the harness runs pluggable agent architectures (`--strategy <name>`
or `/strategy`): `react` (default loop), `single` (one shot), `plan` (plan→execute), `multi`
(sub-agent fan-out), and `toolsmith` (read a connected integration's docs and have sub-agents author
skills for it). See [docs/orchestration.md](docs/orchestration.md).

**Sign in** (optional — identifies you to the backend): run `/login`, choose GitHub or Google, and
enter the device code in your browser. The token is stored locally and sent as your client key.

## Skills

ada ships with **~285 built-in skills** across ~30 categories — specialized instructions the model
pulls in only when a task needs them (progressive disclosure). ada **routes** every request with a
relevance ranker over names + descriptions: when one skill clearly fits, ada **auto-applies** it —
injecting its procedure so even a weak model follows it (announced as `↳ skill: <name>`); when the
match is ambiguous it just suggests them. The model can also browse with **`list_skills`** (by
`category`/`filter`), search with **`find_skill`** (ranked), and load one with **`use_skill`** — so
nothing bloats the prompt until it's used. A sample of the categories:

`git` · `review` · `testing` · `debugging` · `refactoring` · `docs` · `security` · `ci-cd` ·
`performance` · `database` · `api` · `frontend` · `ui-design` · `html` · `pptx` · `image` ·
`graphics` · `languages` · `frameworks` · `mobile` · `cloud` · `observability` · `data-ml` ·
`agent-llm` · `web3` · `networking` · `shell` · `connectors` · `compliance` · …

Examples: `commit`, `code-review`, `dockerize`, `migration`, `react-hooks`, `terraform-module`,
`rag-pipeline`, `security-audit`, `project-overview`, `architecture-diagram`, `graphify`, `ponytail`.

Add your own as `SKILL.md` files under `.ada/skills/<name>/` (project) or `~/.ada/skills/<name>/`
(global) — `---\ndescription: …\ncategory: …\n---` front-matter is all that's required. Project
skills override global, which override the built-ins. Install remote ones with
`ada skill add <url>` (a `SKILL.md` or a JSON index); `ada skill list` shows them.

## Connectors (MCP)

ada reaches external tools and data through MCP servers. Browse the catalog and add one:

```bash
ada mcp                  # list the catalog (filesystem, github, postgres, slack, sentry, …)
ada mcp add github       # write it into .ada/mcp.json, then set the token it prints
```

Both **local stdio** servers (`{ command, args }`) and **remote HTTP** servers (`{ url, headers }`)
are supported; their tools appear as `<server>__<tool>`, approval-gated, in trusted projects. See
[docs/connectors.md](docs/connectors.md), or the `connectors` skill category for per-connector setup.

## Configuration

**Client** (`ada`):

| Env var | Default | Purpose |
|---|---|---|
| `ADA_BACKEND_URL` | `http://localhost:8787/v1` | Where the backend lives |
| `ADA_CLIENT_KEY` | stored login token, else `dev` | Bearer sent to the backend |
| `ADA_MODEL` | — | Default model id |
| `ADA_COMPACT_AT` | `100000` | Token estimate that triggers compaction |
| `ADA_AUTO_APPROVE` | — | `1` ⇒ behave like `--yolo` |
| `NO_COLOR` / `ADA_THEME` | — | Disable color / theme overrides |

**Backend** (`ada-server`):

| Env var | Default | Purpose |
|---|---|---|
| `ADA_PORT` | `8787` | Listen port |
| `ADA_CLIENT_KEYS` | *(unset = dev/no-auth)* | Comma-separated allowed client keys |
| `ADA_REQUIRE_LOGIN` / `ADA_ALLOWED_USERS` | — | Gate access to verified GitHub/Google users |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Local Ollama endpoint |
| *(provider keys)* | — | See the [Providers](#providers) table |

---

## Develop

```bash
npm run typecheck        # tsc --noEmit
npm run selfcheck        # offline checks (tools, sessions, routing, parsers, TUI)
npm start                # run the client from source
npm run server           # run the backend from source
```

See **[docs/architecture.md](docs/architecture.md)** for the design (adapters, routing, request
flow, file layout), **[docs/orchestration.md](docs/orchestration.md)** for the agent strategies, and
**[docs/integrations.md](docs/integrations.md)** for the HTTP API / SDK / ACP.

## Benchmarks

ada can run **SWE-bench Verified** — it generates patches for real GitHub issues (one isolated repo
clone per task), emitting an official-format `predictions.jsonl` that the official `swebench` Docker
harness scores. `node bench/swebench.mjs --dataset … --model … --out runs/x`. See
**[bench/README.md](bench/README.md)** for the full flow (dataset, prereqs, scoring command).

## Contributing

Issues and PRs welcome — it's a small, no-build codebase. Run `npm run typecheck && npm run selfcheck`
before a PR and keep changes lean. See **[CONTRIBUTING.md](CONTRIBUTING.md)**; report vulnerabilities
via **[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE) © 2026 Aditya
