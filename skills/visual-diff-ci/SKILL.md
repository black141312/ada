---
name: visual-diff-ci
description: Wire visual regression into CI with stable rendering, diff artifacts, and tuned tolerance thresholds
category: visual-test
---

# Visual Diff CI

Reach for this when screenshot tests pass locally but flake or fail in CI, or when you're adding visual checks to a pipeline for the first time.

1. Pin the render environment: same browser/engine version, fonts, OS image, and a fixed DPR/viewport — bake it into a container so local == CI.
2. Generate baselines INSIDE that container (or via the test runner's Docker image), never from a developer laptop, or you'll diff against the wrong font hinting.
3. On every run, upload the three images per failing case — baseline, actual, diff — as CI artifacts so a reviewer can see the regression without rerunning.
4. Tune two thresholds: per-pixel color tolerance (absorbs AA) and a max changed-pixel ratio (gates real changes); start strict, loosen only on proven flake.
5. Make baseline updates an explicit, reviewable step (a labeled job or committed `--update-snapshots` PR), never an auto-overwrite on failure.
6. Quarantine and fix flaky cases — disable animations, mock clocks/network, hide carets/scrollbars — rather than raising the threshold to hide them.

## Rules
- Local-vs-CI font/AA mismatch is the top cause of CI-only flake; containerize rendering before touching thresholds.
- Always publish the diff image as an artifact — a red "visual test failed" with no picture is useless to reviewers.
- Never auto-update baselines on failure; that turns the gate into a rubber stamp.
- Loosening tolerance to silence flake hides real regressions — fix determinism instead.
- Shard/parallelize deterministically; non-deterministic data ordering produces phantom diffs.
- Keep baselines in-repo (or LFS) and tied to the commit, so a checkout reproduces the exact expected state.
