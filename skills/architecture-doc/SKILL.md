---
name: architecture-doc
description: Write a concise architecture overview of components, data flow, and key decisions
category: docs
---

# Architecture Doc

Use this when a new contributor (or future you) needs the mental model of how the system fits together, without reading every file. Aim for a short ARCHITECTURE.md, not a spec.

1. Map the major components/modules and what each is responsible for — read entry points and directory layout first.
2. Trace the primary data/request flow end to end (input → processing → storage → output).
3. Draw one diagram (ASCII or Mermaid) showing components and the arrows between them.
4. Document the key technical decisions and constraints (datastore choice, sync vs async, boundaries) and the why.
5. Note external dependencies and integration points (APIs, queues, third-party services).
6. Add a "where things live" map so readers can jump from a concept to the directory/file.
7. Keep it to a couple of screens; link to deeper docs/ADRs instead of expanding inline.

## Rules
- Explain the why behind structure, not just the what — that's the part code can't show.
- One clear diagram beats three; prefer Mermaid so it renders in-repo.
- Describe boundaries and data flow, not implementation line-by-line.
- Call out the non-obvious: surprising couplings, intentional duplication, hot paths.
- Date it lightly and link related ADRs so it stays anchored as the system evolves.
