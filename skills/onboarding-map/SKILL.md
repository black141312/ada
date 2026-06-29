---
name: onboarding-map
description: Map a repo's structure for a newcomer — layout, entry points, key modules, and how to build and run it
category: code-understanding
---

# Onboarding Map

Use when someone is new to a repo and needs a mental model: where things live, what matters, and how to run it.

1. Read the top-level signals first: README, CONTRIBUTING, package/build manifests, and any docs or ARCHITECTURE files.
2. Map the directory layout — name each top-level folder's role (source, tests, config, scripts, infra) in a line each.
3. Identify entry points: main/index files, server bootstrap, CLI commands, or the app's `start` script.
4. Pick out the core modules that carry the domain logic, distinguishing them from glue, vendored code, and generated output.
5. Extract the workflow from the manifest/scripts: how to install, build, test, run, and lint.
6. Summarize as a short orientation — "start here, then read these" — pointing to a handful of files worth reading first.

## Rules
- Lead with the few files that explain the most; do not enumerate every directory.
- Prefer documented commands (package scripts, Makefile, CI config) over inferred ones.
- Flag generated, vendored, or build-output directories so the newcomer does not read them as source.
- Note the primary language(s), framework, and any monorepo/workspace boundaries up front.
- Keep it a map, not a tutorial — point to where to learn, do not re-teach the framework.
