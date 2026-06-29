---
name: architecture-diagram
description: Map a project's components and data flow into a clean architecture diagram (Mermaid or SVG).
category: docs
---

# Architecture Diagram

Use to show how a system fits together — components, boundaries, and how data/control flows between them.

1. Discover the pieces: entry points, modules/services, data stores, external dependencies (read the README, the manifest, and the top-level directories).
2. Trace the main flow: how a request/task moves through the system (client → service → store → external), and which parts own state vs. are stateless.
3. Lay it out in tiers (left→right or top→down): ≤ ~4 boxes per tier, group related pieces in subgraphs, draw arrows for the *real* call/data direction (and a return path only if it matters).
4. Render it: a fenced ` ```mermaid ` flowchart for a committed, editable diagram, or a hand-authored SVG for a polished on-brand one. Save to `docs/architecture.{md,svg}` and embed it in the README.
5. Add a one-line caption of the key design idea (e.g. "one adapter per wire format").

## Rules
- Diagram the system as it IS in the code, not an idealized version.
- Components and boundaries, not every file — keep it at the level a newcomer needs.
- Label arrows with what flows (requests, events, SSE) and mark external/3rd-party pieces distinctly.
- Keep the source (Mermaid/SVG) in the repo so the picture stays in sync with the code.
