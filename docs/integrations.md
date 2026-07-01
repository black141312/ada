# Integrating with ada

ada exposes a few programmatic surfaces so other tools can drive it. The buildable foundations are
shipped; the product surfaces that need *external* infrastructure (a Slack app, hosting, an Electron
build, an IdP) are described with what they'd take — they can't be "live" without your accounts.

## HTTP API — `ada serve`

```bash
ada serve            # → http://localhost:8788  (ADA_HTTP_PORT to change)
```
- `GET /health` → `{ ok, model, sessions }`
- `POST /v1/prompt` `{ "text": "...", "model"?: "..." }` → `{ text, usage }` — **one-shot**: a fresh
  agent + fresh session per call, no memory between calls. Good for a "generate this" button, not a
  chat panel.

### Building a Cursor-style agent panel (an IDE integration)

For a real agent panel — persistent conversation, live streamed output, visible tool calls, and
edits that pause for **your own** approval UI instead of auto-running — use the **interactive
session** endpoints instead. This is the intended integration point for a custom IDE/editor, in any
language, over plain HTTP + Server-Sent Events:

```
GET  /v1/sessions                        → { sessions: [{ file, title, mtime, parent? }, …] }
POST /v1/sessions {"resume"?: "latest"|"<file>"} → { sessionId, model, file, resumed }
POST /v1/sessions/:id/prompt {"text":…, "images"?: [dataURL|https…]}
                                         → SSE stream of events (see below), until "done"
                                           (409 if a turn is already running on this session)
POST /v1/sessions/:id/approve {"id":…, "decision":"yes"|"all"|"no"}
POST /v1/sessions/:id/abort              → cancel the running turn ("stop generating"); also
                                           denies any approval it was parked on
POST /v1/sessions/:id/steer {"text":…}   → queue a mid-turn user message (409 when idle)
PATCH /v1/sessions/:id {"mode":"ask"|"plan"|"auto"} → switch the permission mode live
DELETE /v1/sessions/:id                  → free the session (does not delete the transcript)
```

The session holds one persistent `Agent` — history, model, and skill/tool state carry across every
`/prompt` call. Each `/prompt` call streams one event per SSE frame (`data: {...}\n\n`):

| `type` | Fields | Meaning |
|---|---|---|
| `text` | `delta` | A chunk of the assistant's reply |
| `tool_call` | `name`, `detail` | A tool is about to run |
| `tool_result` | `name`, `output`, `isError` | It finished |
| `approval_request` | `id`, `name`, `summary` | **Blocks** until you POST `.../approve` with this `id` — this is where your IDE shows its own "allow this edit?" UI |
| `done` | `text`, `usage` | Turn complete |
| `error` | `message` | The turn failed (e.g. upstream unreachable) |

Sessions default to `autoApprove: false` (unlike the one-shot `/v1/prompt`, which auto-approves
everything) — every gated tool call (file writes, destructive shell, …) fires `approval_request` and
waits for your response. If no `/prompt` stream is currently open when an approval is needed, it's
declined (fails closed, never runs silently).

**Resuming after a restart.** Sessions live in memory, so a `sessionId` doesn't survive `ada serve`
restarting — but every session's conversation is also persisted to an on-disk transcript
(`.ada/sessions/*.jsonl`), same as the CLI's own sessions. `GET /v1/sessions` lists them (newest
first); pass `resume: "latest"` or a specific `file` from that list to `POST /v1/sessions` to spin up
a **new** in-memory session seeded with that history — the conversation picks up right where it left
off. Verified live: kill `ada serve` mid-conversation, restart it, resume, and the model still recalls
what was said before the restart.

## Typed SDK — `src/sdk`

```ts
import { createClient } from "ada-agent/sdk"; // in-repo: "./src/sdk/index.ts"
const ada = createClient("http://localhost:8788");

// one-shot
const { text } = await ada.prompt("list the files in this project");

// interactive — the IDE integration point
const session = await ada.session({ model: "claude-opus-4-8" });
await session.prompt("refactor foo.ts to use async/await", (e) => {
  if (e.type === "text") process.stdout.write(e.delta);
  if (e.type === "tool_call") console.log(`→ ${e.name} ${e.detail}`);
  if (e.type === "approval_request") session.approve(e.id, myOwnConfirmUi(e) ? "yes" : "no");
  if (e.type === "done") console.log("\n" + e.usage);
});
await session.close();
```

It's a `fetch`-based wrapper (manual SSE parsing, no dependency) over the HTTP API above — if you'd
rather not pull in the source, or your IDE isn't Node/TypeScript, talk to the same endpoints directly
from any HTTP client that can read a chunked response (Java, Python, Rust, a browser, …).

## ACP bridge — `ada acp`

A minimal Agent Client Protocol bridge over stdio (JSON-RPC 2.0, newline-delimited): handles
`initialize` and `session/prompt`, so an ACP-aware editor can drive ada. It's a **scaffold** — method
names and framing may need adjusting to your client's ACP version.

## Session share — `ada share`

```bash
ada share              # serve the latest session as a read-only web page (localhost)
ada share <name|file>  # a specific session
```
Local and read-only. A *public* share link would need a hosted backend to receive and serve the
transcript (see below).

---

## Needs your infrastructure (foundations are here; the rest is your accounts/hosting)

These are all buildable **on top of the HTTP API / SDK above** — what's missing is the external
service, which only you can provision.

- **Slack bot** — a [Slack Bolt](https://slack.dev/bolt-js) app that, per thread, calls
  `createClient().prompt(message)` and posts the reply. Needs a **Slack app + bot token** (`SLACK_BOT_TOKEN`)
  and a running process. ~30 lines on top of the SDK.
- **Web console** — a single page that POSTs to `/v1/prompt` and renders the reply (the `ada share`
  server is a minimal read-only version). Needs **hosting** + CORS if cross-origin.
- **Desktop app** — an Electron shell that spawns `ada serve` and points a webview at it. Needs the
  **Electron build/packaging** pipeline (you already have the separate `ada-ide` VS Code fork).
- **Public session sharing** — `ada share` is local; a public link needs a **hosted endpoint** to
  receive the transcript and a viewer (like opencode's `console.opncd.ai`).
- **Enterprise / identity / teams** — multi-tenant accounts + SSO need an **IdP and a control plane**;
  out of scope for a single-binary CLI.
- **SQLite session store** — ada uses append-only JSONL (`.ada/sessions/*.jsonl`) by design (no native
  dep, greppable, trivially portable). Node 24 ships an experimental `node:sqlite`; a SQLite backend is
  a drop-in for `session.ts` if you want indexed queries — say the word and it's a small module.
