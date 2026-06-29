---
name: diagram-as-code
description: Author architecture diagrams as code (PlantUML, D2, or Graphviz) and render them to SVG in the build.
category: docs
---

# Diagram As Code

Use when diagrams must be version-controlled, reviewed in PRs, and regenerated deterministically — pick this over hand-drawn tools for anything that outlives a single meeting.

1. Choose the tool: D2 for modern layout and clean syntax, PlantUML for rich UML (class/component/sequence), Graphviz/DOT for graph-theoretic or auto-laid-out graphs.
2. Put the source in the repo next to the doc (`diagrams/auth.d2`, `*.puml`, `*.dot`) — text in, image out.
3. Write the diagram, naming nodes by their real system role and grouping with containers/clusters/packages.
4. Render to SVG (vector, scalable, diffable-ish): `d2 auth.d2 auth.svg`, `plantuml -tsvg arch.puml`, or `dot -Tsvg graph.dot -o graph.svg`.
5. Reference the rendered SVG from Markdown; commit both source and output, or generate output in CI.
6. Add a make target / npm script (`make diagrams`) so anyone can regenerate all images with one command.
7. Re-render and review the visual diff whenever the source changes; never edit the SVG by hand.

## Rules
- Source of truth is the `.d2`/`.puml`/`.dot` file — the SVG is a build artifact.
- Prefer SVG over PNG: crisp at any zoom, smaller, and partly readable in diffs.
- Pin the renderer version (container image or lockfile) so layout stays stable across machines.
- Let the layout engine place nodes; only nudge with constraints when the auto-layout is genuinely wrong.
- Keep one diagram per file so renders and reviews stay focused.
