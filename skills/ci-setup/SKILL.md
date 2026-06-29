---
name: ci-setup
description: Add a CI workflow that builds, lints, and tests the project on every push and PR
category: ci-cd
---

# CI Setup

Reach for this when a repo has no continuous integration and you want every push/PR to build, lint, and test automatically.

1. Detect the stack and its scripts: read the manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Makefile`) to find the real build/lint/test commands.
2. Pick the CI provider already implied by the host (GitHub -> Actions in `.github/workflows/`, GitLab -> `.gitlab-ci.yml`) rather than introducing a new one.
3. Write one workflow triggered on `push` to the default branch and on `pull_request`, running on the matching runner image.
4. Order jobs/steps as checkout -> setup runtime (pinned version) -> restore dependency cache -> install -> lint -> build -> test.
5. Run lint/build/test as the SAME commands a developer runs locally, so green CI means a green local checkout.
6. Commit, push a branch, open a PR, and confirm the workflow actually ran and passed before declaring done.

## Rules
- Pin runtime versions (Node 20, Python 3.12) — never rely on the runner default drifting.
- Reuse existing npm/make scripts; do not hardcode a parallel command that can silently diverge.
- Make the job fail loudly: no `|| true`, no `continue-on-error` on the steps that gate quality.
- Enable dependency caching keyed on the lockfile hash to keep runs fast.
- Keep secrets out of the YAML; reference provider secret stores, never inline tokens.
