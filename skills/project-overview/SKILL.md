---
name: project-overview
description: Describe a project well — purpose, architecture, layout, and how to run it — for a README or newcomer.
category: docs
---

# Project Overview

Use to describe a project clearly: what it is, why, how it's built, and how to run it.

1. Explore: read the README/manifest (`package.json`, `pyproject.toml`, `go.mod`), the entry points, the top-level directory tree, and recent git history to infer purpose and what's active.
2. State the purpose in 1-2 sentences — what it does and who/what it's for — without jargon.
3. Describe the architecture: the main components, how they fit together, and the one or two design decisions that shape it (link an architecture diagram rather than re-prosing it — see the `architecture-diagram` skill).
4. Map the layout: a short tree of the key directories/files, one line of role each.
5. Give the essentials: install, run, test, and configuration (env vars), with copy-pasteable commands.
6. Write it where it belongs (README or `docs/`), honest about what's done vs. planned.

## Rules
- Accurate over impressive — describe what the code actually does; verify the commands run.
- Lead with purpose: a reader should get "what & why" in the first three lines.
- Link the diagram, don't duplicate it in words.
- Cut boilerplate — every line should help someone use or extend the project.
