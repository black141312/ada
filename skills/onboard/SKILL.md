---
name: onboard
description: Generate a dev-setup and onboarding guide for the repo from its actual config and entry points
category: meta
---

# Onboard

Reach for this when a repo lacks a clear "get started" path and a new contributor would have to reverse-engineer setup. Produces a concrete, verified onboarding guide grounded in the repo's real files.

1. Detect the stack: read manifests and lockfiles (`package.json`, `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`) plus version pins (`.nvmrc`, `.tool-versions`, `.python-version`) and container files (`Dockerfile`, `compose.yaml`).
2. Extract the real commands from scripts/targets (npm `scripts`, `Makefile`, `Justfile`, `Taskfile`) rather than inventing them — note install, build, run, test, lint.
3. Find required config: scan for `.env.example`, secret/config templates, and CI workflows (`.github/workflows`) to learn what env vars and services (DB, cache, queues) the app expects.
4. Map entry points: identify how to start the app and where the codebase begins (main/server file, top-level packages) and how to run a single test.
5. Verify the happy path by running install + build + test (or a fast subset); record any step that fails and the fix.
6. Write `ONBOARDING.md` (or `CONTRIBUTING.md`) with prerequisites, exact copy-paste setup steps, run/test commands, env vars table, and a "first PR" pointer.

## Rules
- Only document commands that exist in the repo or that you actually ran — never guess invocations.
- Pin tool versions you observed; flag when none is specified instead of assuming "latest".
- List env vars as a table (name, required?, example/default) sourced from `.env.example` and code, never real secret values.
- Keep steps copy-pasteable and OS-aware; call out platform-specific commands (bash vs PowerShell) when they differ.
- If a setup step fails, fix or clearly mark it as broken — do not ship an untested guide.
