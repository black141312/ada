---
name: makefile
description: Generate a Makefile or task runner exposing common project commands behind short aliases
category: ci-cd
---

# Makefile

Use when a project's everyday commands are long or scattered and you want one discoverable entrypoint (`make test`, `make run`).

1. Collect the real commands developers run: install, build, lint, test, format, run, clean.
2. Create a target per command with a short, conventional name; have each shell out to the actual tool.
3. Declare `.PHONY` for every target that isn't a file, so they always run.
4. Add a default `help` target (self-documenting via `##` comments) so `make` lists what's available.
5. Compose targets where it helps (`ci: lint test build`, `check: lint test`) to mirror the pipeline.
6. Run each target to confirm it works; reference the same targets from CI so local and CI commands stay identical.

## Rules
- Recipe lines must be tab-indented, not spaces — the classic Makefile footgun.
- Mark non-file targets `.PHONY` or stale files silently skip them.
- Keep targets thin wrappers over the real tools; don't reimplement logic in make.
- Have CI call the same `make` targets so there's one source of truth for commands.
- On Windows/non-make environments prefer a `justfile` or npm scripts instead of forcing make.
