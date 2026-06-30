# Integrating with ada

ada exposes a few programmatic surfaces so other tools can drive it. The buildable foundations are
shipped; the product surfaces that need *external* infrastructure (a Slack app, hosting, an Electron
build, an IdP) are described with what they'd take — they can't be "live" without your accounts.

## HTTP API — `ada serve`

```bash
ada serve            # → http://localhost:8788  (ADA_HTTP_PORT to change)
```
- `GET /health` → `{ ok, model }`
- `POST /v1/prompt` `{ "text": "...", "model"?: "..." }` → `{ text, usage }` (runs a fresh agent turn)

## Typed SDK — `src/sdk`

```ts
import { createClient } from "ada-agent/sdk"; // in-repo: "./src/sdk/index.ts"
const ada = createClient("http://localhost:8788");
console.log(await ada.health());
const { text } = await ada.prompt("list the files in this project");
```

It's a ~30-line `fetch` wrapper over the HTTP API above — if you'd rather not pull in the source,
just POST to `/v1/prompt` directly.

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
