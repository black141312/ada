---
name: render-diagram
description: Show a diagram from a terminal — draw it inline in Unicode, or render mermaid to HTML and open it in the browser.
category: docs
---

# Render Diagram

ada runs in a terminal, so a "diagram" is either **drawn inline** with text, or **rendered to a file
and opened in the browser**. Pick by how rich the diagram needs to be.

## 1. Simple → draw it inline (no files, no browser)

For flows, trees, small architectures, comparisons — draw it directly in the reply with box-drawing
glyphs. Keep it under ~15 nodes and align columns so it reads cleanly. Example:

```
┌─ ada ────┐   HTTP   ┌─ ada-server ─┐      ┌ OpenRouter
│  client  │ ───────▶ │  routes+keys │ ──▶  ┤ Anthropic
└──────────┘          └──────────────┘      └ Ollama …
```

Glyphs: boxes `╭ ╮ ╰ ╯ ┌ ┐ └ ┘ │ ─ ├ ┤ ┬ ┴`; edges `→ ▶ ↓ ⎿`; trees indent with `├─`/`└─`.

## 2. Rich / interactive / shareable → render mermaid and open it

When inline can't do it justice (big graph, real layout, sequence/ER/gantt), or the user wants an
image/file:

1. Choose the mermaid type by intent: `flowchart TD` (process/decisions), `sequenceDiagram`
   (interactions over time), `stateDiagram-v2` (states), `erDiagram` (data model), `classDiagram`,
   `gantt`, `mindmap`.
2. With `write_file`, write a **self-contained HTML file to a scratch path** (absolute, e.g. the OS
   temp dir or `~/.ada/diagrams/<slug>.html` — never the user's source tree unless they ask). Use
   this template; put your mermaid between the `<pre class="mermaid">` tags:

   ```html
   <!doctype html><meta charset="utf-8"><title>DIAGRAM TITLE</title>
   <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
   <style>body{background:#0d1117;color:#c9d1d9;font:14px system-ui;margin:0;min-height:100vh;display:grid;place-items:center}</style>
   <pre class="mermaid">
   flowchart TD
     A[Load config] --> B{Valid?}
     B -->|yes| C[Run]
     B -->|no| D[Report error]
   </pre>
   <script>mermaid.initialize({startOnLoad:true,theme:'dark'})</script>
   ```

3. Open it in the default browser with `bash` — use the line for the OS (`f` = the file path):
   - Windows: `start "" "$f"`
   - macOS:   `open "$f"`
   - Linux:   `xdg-open "$f"`
   - Portable: `xdg-open "$f" 2>/dev/null || open "$f" 2>/dev/null || start "" "$f"`
4. Tell the user it opened and print the file path, so they can reopen or share it.

## Rules

- **Default to inline (§1)** — it stays in the transcript and needs nothing. Reach for §2 only when
  inline genuinely can't render the diagram, or the user wants a file/image.
- Mermaid node **IDs are code, labels are prose**: quote any label with spaces/punctuation —
  `A["Retry (max 3)"]` — or the block fails to render.
- The template pulls mermaid.js from a CDN, so §2 needs internet; if offline, fall back to §1.
- One idea per diagram — split a big flow into several rather than one unreadable graph.
