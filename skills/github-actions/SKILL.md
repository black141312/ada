---
name: github-actions
description: Author or fix a GitHub Actions workflow with correct triggers, jobs, caching, and permissions
category: ci-cd
---

# GitHub Actions

Use when creating a new `.github/workflows/*.yml` or debugging one that fails, misfires, or runs too often.

1. Set the right triggers in `on:` (`push`, `pull_request`, `workflow_dispatch`, `schedule`) and scope branches/paths to avoid noise.
2. Define jobs with a pinned `runs-on` image; use a `matrix` only when you genuinely test multiple versions.
3. Pin actions to a tag or SHA (`actions/checkout@v4`), set up the runtime, and cache deps with `actions/cache` or the setup action's built-in cache.
4. Grant least-privilege `permissions:` (default read; add `contents: write` / `id-token: write` only where needed).
5. Store credentials in repo/org Secrets and reference via `${{ secrets.X }}`; never echo them.
6. Validate by pushing to a branch and reading the run logs; when fixing, reproduce the failing step and inspect its exact output.

## Rules
- Pin third-party actions by SHA or major tag — floating `@master` is a supply-chain risk.
- Set explicit `permissions:` per workflow or job; the broad default token is too powerful.
- Add `concurrency:` with `cancel-in-progress` to kill superseded runs on the same ref.
- Don't print secrets to logs and don't expose them to PRs from forks.
- When debugging, read the failing job's logs first — guessing at YAML wastes runs.
