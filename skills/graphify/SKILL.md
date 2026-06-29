---
name: graphify
description: Turn code, data, or relationships into a clear visual graph (Mermaid/Graphviz), then render it.
category: docs
---

# Graphify

Use when a relationship, flow, hierarchy, or dependency would land better as a picture than prose.

1. Identify the **nodes** (entities) and **edges** (relationships), and what each edge means — calls, depends-on, contains, flows-to.
2. Pick the graph type that fits: flowchart (a process), sequence (interactions over time), ER (a data model), class (types), state (modes), or a dependency graph (modules/packages).
3. Express it as code — prefer **Mermaid** (renders on GitHub and most viewers) in a fenced ` ```mermaid ` block; use Graphviz/DOT or D2 when you need precise layout control.
4. Keep it legible: ≤ ~15 nodes per view, short labels, group with subgraphs, `LR` direction for wide flows and `TB` for hierarchies.
5. Put it in a doc (e.g. `docs/<name>.md`) or render to SVG/PNG (`mmdc -i in.mmd -o out.svg`, `dot -Tsvg`) and link it.

## Rules
- One graph = one idea. If it needs a legend longer than the graph, split it.
- Derive nodes/edges from the actual code/data — don't invent structure.
- Label edges with the relationship, not just bare arrows.
- Re-render after edits so the committed image matches its source.
