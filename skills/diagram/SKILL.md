---
name: diagram
description: Draw a diagram — architecture, flow, sequence, ER, state or dependency — as mermaid, diagram-as-code, or inline text, then show it.
category: docs
---

# Diagram

Use when a relationship, flow, hierarchy or dependency lands better as a picture than as prose.

1. **Say what the diagram asserts** in one sentence ("every wire format goes through one adapter"). That sentence decides what goes in and what stays out.
2. **Pick the type from that intent:** `flowchart` (process/decisions), `sequenceDiagram` (interactions over time), `erDiagram` (data model), `stateDiagram-v2` (state machine), `classDiagram` (types), dependency graph (modules), `gantt`/`timeline` (schedule).
3. **For a system architecture, discover the real pieces first** — entry points, modules/services, data stores, external dependencies (read the README, the manifest, the top-level dirs). Trace how one request moves through it, and note which parts own state. Lay it out in tiers of ≤ ~4 boxes, group with subgraphs, and mark third-party pieces distinctly.
4. **Author it** — see the two routes below.
5. **Show it** — see "Showing it".
6. **Keep the source in the repo** next to the doc, so the picture stays in sync with the code.

## Route 1 — mermaid (default)

Renders natively on GitHub, GitLab, MkDocs Material and Docusaurus, and stays diffable in git.

- Open a ` ```mermaid ` fence and declare type + direction on line one (`flowchart TD`).
- Nodes get stable IDs and human labels (`A[Load config]`), then edges (`A --> B`, `-->|label|` for edge text).
- `TD`/`LR` is a deliberate choice; sequence diagrams flow top-down regardless.
- Comment intent with `%% ...` so the next editor knows what the diagram claims.
- Verify it renders — one syntax error blanks the whole block. For doc sites, confirm the plugin is on (MkDocs: `pymdownx.superfences` custom fence; Docusaurus: `@docusaurus/theme-mermaid`).

## Route 2 — diagram as code (D2 / PlantUML / Graphviz)

Reach for this when the diagram must be regenerated deterministically in a build, or mermaid's layout isn't good enough: **D2** for clean modern layout, **PlantUML** for rich UML, **Graphviz/DOT** for auto-laid-out graphs.

- Source goes in the repo next to the doc (`diagrams/auth.d2`, `*.puml`, `*.dot`) — text in, image out.
- Render to SVG: `d2 auth.d2 auth.svg`, `plantuml -tsvg arch.puml`, `dot -Tsvg graph.dot -o graph.svg`.
- Add a `make diagrams` target so anyone can regenerate everything with one command, and pin the renderer version so layout stays stable across machines.
- Commit source and output, or generate the output in CI. Never hand-edit the SVG.

## Showing it

ada runs in a terminal, so pick by how rich the picture has to be.

**Simple → draw it inline.** No files, no browser, and it stays in the transcript. Under ~15 nodes, columns aligned:

```
┌─ ada ────┐   HTTP   ┌─ ada-server ─┐      ┌ OpenRouter
│  client  │ ───────▶ │  routes+keys │ ──▶  ┤ Anthropic
└──────────┘          └──────────────┘      └ Ollama …
```

Glyphs: boxes `╭ ╮ ╰ ╯ ┌ ┐ └ ┘ │ ─ ├ ┤ ┬ ┴`; edges `→ ▶ ↓ ⎿`; trees indent with `├─`/`└─`.

**Rich / shareable → render mermaid and open it.** Write a self-contained HTML file to a scratch path (absolute — the OS temp dir or `~/.ada/diagrams/<slug>.html`, never the user's source tree unless asked):

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

Open it with `bash` — Windows `start "" "$f"`, macOS `open "$f"`, Linux `xdg-open "$f"`, portable `xdg-open "$f" 2>/dev/null || open "$f" 2>/dev/null || start "" "$f"`. Then print the path so it can be reopened or shared.

**In a doc →** the ` ```mermaid ` fence itself, or the rendered SVG linked from Markdown. Save architecture work to `docs/architecture.{md,svg}` and embed it in the README.

## Rules
- One diagram, one idea. If the legend is longer than the picture, split it.
- Diagram the system as it IS in the code, never an idealized version, and derive nodes/edges from the actual code or data.
- Components and boundaries, not every file — the level a newcomer needs.
- Label edges with what flows (requests, events, SSE), not bare arrows.
- Mermaid IDs are code, labels are prose: quote anything with spaces or punctuation — `A["Retry (max 3)"]`.
- Default to inline when it will do; the browser route needs internet for the CDN.
- ~5–15 nodes per view. If it needs zoom and pan, it is two diagrams.
- Prefer SVG over PNG — crisp at any zoom, and partly readable in a diff.
- Re-render after every source edit so the committed image matches its source.
