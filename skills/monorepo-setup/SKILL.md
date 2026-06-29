---
name: monorepo-setup
description: Set up a workspace monorepo (pnpm/turbo/nx) with shared deps and a working task graph
category: dependencies
---

# Monorepo Setup

Use when consolidating multiple packages into one repo with shared tooling and a single dependency graph.

1. Pick the workspace manager (pnpm workspaces, npm/yarn workspaces) and declare package globs (`pnpm-workspace.yaml` or `"workspaces"`).
2. Lay out `packages/*` and `apps/*`, give each a package.json with a scoped name, and reference siblings via `workspace:*`.
3. Hoist shared config (tsconfig base, eslint, prettier) to the root and extend it per package.
4. Add a task runner (Turborepo or Nx) and define the build/test/lint pipeline with correct `dependsOn` ordering and caching.
5. Wire a single root lockfile and install once at the root so cross-package versions stay consistent.
6. Verify with a clean install plus a from-scratch `build`/`test` across the graph, then enable remote/CI caching.

## Rules
- One lockfile at the repo root — never per-package lockfiles in a workspace.
- Reference internal packages with `workspace:` protocol, not a published version, so local changes resolve.
- Declare task `dependsOn` so the runner builds dependencies before dependents.
- Keep each package's dependencies in its own package.json; don't dump everything in the root.
- Make the cache key include inputs (source + config) so stale cache hits don't ship wrong output.
