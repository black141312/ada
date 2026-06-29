---
name: visual-regression
description: Baseline and pixel-diff screenshots so a UI change can't silently regress an unrelated view
category: visual-test
---

# Visual Regression

Reach for this when a code change "shouldn't touch the UI" but you need proof, or when a regression slipped through and you want a net under it.

1. Establish baselines from a known-good commit: render each target state to a deterministic PNG and commit those under `__snapshots__/` (or your tool's baseline dir).
2. Make the change, re-render the same states with identical viewport/DPR/theme, and pixel-diff each new shot against its baseline.
3. For every diff, open the highlighted-diff image: confirm whether the delta is the *intended* change or a *collateral* regression.
4. If intended, update the baseline deliberately (`--update-snapshots`) and review the new PNG in the diff before committing it.
5. If unintended, fix the code and re-run until only the expected states differ.
6. Lock in determinism (frozen time, disabled animations, mocked data, fixed fonts) so reruns are byte-stable.

## Rules
- Treat baselines as source: review every snapshot update in the PR like code; a blind `--update-all` defeats the entire net.
- Render in the SAME environment as CI (font rendering, GPU/SwiftShader, OS) or you get diffs from anti-aliasing, not bugs — see visual-diff-ci.
- Mock everything non-deterministic: clocks, random, network, animations, carets, scrollbars.
- Set a small per-pixel + total-diff tolerance to absorb sub-pixel AA, but keep it tight enough to catch a 1px shift.
- One state per snapshot — giant full-page baselines make every diff ambiguous and every update a rubber-stamp.
