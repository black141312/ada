# ada — feature checklist (gap vs pi)

What `ada` already has, and what pi's coding agent has that `ada` doesn't yet. Ordered by impact
within each group. `[x]` = done, `[ ]` = missing.

> Note: `ada` also has something pi does **not** — a centralized routing backend (Cursor-style:
> keys/limits/billing live in one place). So it's not a strict subset.

## Have

- [x] Cursor-style routing backend (client → backend → providers; keys only on the backend)
- [x] Provider adapters: native Anthropic (lazy SDK) + OpenAI-compatible pass-through (the rest)
- [x] Shape-first routing (`/`→OpenRouter, `:`→Ollama, then name prefixes) + live model discovery
- [x] Tools: `read_file`, `write_file`, `edit_file` (exact), `bash`
- [x] Approval gating (`[y/a/N]`) before write/edit/bash
- [x] Sessions: flat append-only JSONL (`--continue` / `--resume`)
- [x] Context compaction (chars/4 estimate, `/compact`, auto-threshold, overflow retry)
- [x] typecheck + offline selfcheck

## Missing (from pi)

### Tools & file ops
- [x] `grep` — content search (pure-Node walk; ripgrep optional later for speed)
- [x] `glob` — file search (Node's built-in globber)
- [x] `ls` — directory listing
- [x] `edit`: multi-edit + BOM/line-ending preservation + CRLF/LF-tolerant matching
- [x] `read`: offset/limit + image guard. **Vision via `/image <path>` / `/paste`** — attached to the user turn (OpenAI tool-results can't carry images, so vision lives on the message, not the read tool)
- [x] file-mutation queue (per-path promise chain serializes same-file writes)
- [x] streaming output accumulator with temp-file spill (`.ada/tmp`) for huge output

### Rendering (real TUI vs raw text)
- [x] markdown rendering (headings/bold/inline-code/lists/fences; streaming, line-buffered)
- [x] syntax-highlighted code blocks (dependency-free heuristic: keywords/strings/numbers/comments)
- [x] colored diffs for edits (line-level; word-level intra-line later)
- [x] themes (light/dark via `ADA_THEME`)
- [x] selector/dialog components (arrow-key picker for model + session)

### Agent loop
- [x] steering — type during a turn; injected after the current turn
- [x] queue input while streaming (the steer queue)
- [x] Esc-to-interrupt / abort a running turn (Esc or Ctrl+C)
- [x] retry with exponential backoff (transient/429/5xx, visible "[retrying]")
- [x] parallel tool execution (read-only tools run concurrently; gated tools stay sequential)

### Extensibility (pi's defining trait)
- [x] extensions — load JS/TS (file or dir), custom tools + `onStart` hook (`.ada/extensions/`)
- [x] skills — `SKILL.md`, model-invocable via a `use_skill` tool
- [x] prompt templates — user `/commands` (`.ada/prompts/*.md`, `$ARGUMENTS`/`$1`)
- [x] MCP servers (stdio JSON-RPC client, `.ada/mcp.json`, tools as `<server>__<tool>`)
- [x] package manager — `ada add <git-url | npm-package>` into `.ada/extensions/`

### Sessions
- [x] branching session tree (`/fork` seeds a child session, records parent)
- [x] `/tree` navigation + time-travel (`/tree` shows lineage, `/rewind` drops the last turn)
- [x] branch summaries (first user message is the branch label in `/tree`)

### Models & auth
- [x] OAuth logins — RFC 8628 device flow (`ada login github|google`); token verified backend-side as **identity** (allowlist via `ADA_ALLOWED_USERS`), not as a provider key. Client IDs via `ADA_OAUTH_*` env
- [x] credential store with file-locked refresh (`~/.ada/credentials.json`, atomic write + lock)
- [x] thinking/reasoning-level control (`--reasoning` / `/reasoning`, sends `reasoning_effort`)
- [x] model scoping / cycling (`--models a,b,c` + `/next`)
- [x] per-model cost + token tracking (`/cost`; `stream_options.include_usage` + price table)
- [x] fuzzy model-id matching (in the model picker)

### Config & safety
- [x] layered settings (`~/.ada/settings.json` + project `.ada/settings.json`, project wins)
- [x] project-trust gate (prompt before loading any project `.ada` resources)
- [x] load `AGENTS.md` / `CLAUDE.md` context files (into the system prompt)
- [x] configurable keybindings (`settings.keybindings.interrupt`)

### Modes
- [x] print mode (`-p "prompt"` + `--json`, non-interactive, auto-approve)
- [x] RPC / headless SDK protocol (`--rpc`, newline-delimited JSON over stdio)

### Infra & polish
- [x] telemetry / observability (local JSONL + optional OTLP POST via `ADA_OTLP_ENDPOINT`; opt-out `ADA_TELEMETRY=0`)
- [x] prompt caching + cache-retention control (Anthropic `cache_control` on system+tools; `ADA_CACHE_TTL=1h`)
- [x] clipboard paste + **image paste** (`/paste`, cross-platform)
- [x] self-update (`ada update` → git pull)
- [x] cross-platform niceties (WSL / Termux / tmux detection; platform-aware clipboard)

## Suggested order (highest leverage first)

1. ~~`grep` + `glob` + `ls`~~ — ✅ done
2. ~~diff + markdown rendering~~ — ✅ done (incl. syntax highlighting, themes, selectors)
3. ~~Esc-to-interrupt + steering~~ — ✅ done
4. ~~extensions / skills~~ — ✅ done

**Everything in this checklist is now implemented**, including multimodal: images attach to the user turn via
`/image <path>` or `/paste` and translate to OpenAI image parts (pass-through) or Anthropic image blocks (native
adapter). All `selfcheck`-covered where offline-testable. Nothing deferred. (Vision quality depends on using a
vision-capable model — e.g. gpt-4o, Claude, or an Ollama vision model like `llava`/`gemma3`.)

## Round 2 — pi *platform* parity (things pi ships as extensions)

Audited against pi's actual repo (`packages/coding-agent`): ada already matched pi's **core tools** and **modes**.
These close the deeper, platform-level gaps:

- [x] **Plan mode** — `/plan` gates all mutations (read-only investigate → numbered plan → `/run` to execute)
- [x] **Todo / task tracking** — `update_todos` tool the model maintains; `/todos` renders ✓/▸/○
- [x] **Git-checkpoint undo** — original file content captured before any write/edit; `/undo` restores (removes new files)
- [x] **Granular permissions** — `settings.protectedPaths` deny edits; destructive shell (`rm -rf`, `git push --force`, …) always confirmed even in `--yolo`
- [x] **Subagent / handoff** — `spawn_agent` tool delegates an isolated subtask to a fresh ada agent
- [x] **Extension SDK depth** — extensions now contribute `hooks` (`onUserMessage` input transform, `beforeTool` deny/rewrite, `afterTool` post-process) and `commands` (real slash commands), beyond `tools`+`onStart`
- [x] **Notifications + status line** — bell/OS notify on long-turn completion; dim status line (model · plan · ~tokens) above the prompt
- [x] **TUI mode** (`npm start -- --tui`) — a scroll-region terminal UI (`tui.ts` + `tui-mode.ts`): pinned status +
      composer footer with the agent's output scrolling above, a live spinner, raw-mode input with ↑/↓ history,
      Esc-to-interrupt / type-to-steer, and in-footer `y/a/n` approvals. **Opt-in** — the readline REPL stays the default
      and fallback. A lean ~200-line engine (DECSTBM scroll region + fake-cursor footer), not a full component
      framework like pi's, but it delivers the app-like terminal experience.
