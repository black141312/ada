---
name: mermaid-diagram
description: Add Mermaid flowchart, sequence, or ER diagrams to Markdown docs that render on GitHub and most doc sites.
category: docs
---

# Mermaid Diagram

Use when a diagram belongs *in* the doc and should stay diffable in git — Mermaid renders natively on GitHub, GitLab, MkDocs Material, and Docusaurus.

1. Choose the diagram type by intent: `flowchart` for process/decisions, `sequenceDiagram` for interactions over time, `erDiagram` for data models, `stateDiagram-v2` for state machines.
2. Open a fenced block tagged ```` ```mermaid ```` and declare the type and direction on the first line (e.g. `flowchart TD`).
3. Define nodes with stable IDs and human labels (`A[Load config]`), then edges (`A --> B`); use `-->|label|` for edge text.
4. Keep each diagram to one idea (~5-15 nodes); split large flows into multiple diagrams rather than one unreadable graph.
5. Verify rendering — paste into the Mermaid Live Editor (mermaid.live) or your doc preview; a single syntax error blanks the whole block.
6. For doc sites, confirm the Mermaid plugin is enabled (MkDocs: `pymdownx.superfences` custom fence; Docusaurus: `@docusaurus/theme-mermaid`).

## Rules
- IDs are code, labels are prose: never put spaces or punctuation in a bare node ID — wrap the label in `[]`, `()`, or `{}`.
- Escape special characters in labels with quotes: `A["Retry (max 3)"]`.
- Pick `TD`/`LR` deliberately; sequence diagrams flow top-down regardless.
- Don't embed huge diagrams inline — if it needs zoom/pan, link to a standalone page.
- Comment intent with `%% ...` so the next editor knows what the diagram is asserting.
