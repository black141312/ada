---
name: write-tests
description: Write and run focused tests for a change — find the runner, add cases, run, report.
category: testing
---

# Write tests

1. **Detect the setup.** Check `package.json` `scripts.test`, or look for existing `*test*` / `*spec*` files and the framework in use (vitest, jest, mocha, pytest, `go test`, …). Match the project's existing style exactly.
2. **Pick what to cover.** The change's happy path plus the edge cases that would actually break it: empty input, boundaries, error paths. Don't test trivial getters or framework code.
3. **Write the tests** next to their siblings, following local conventions for naming, imports, and assertions.
4. **Run them** with the project's command (`npm test`, `pytest -q`, `go test ./...`, …).
5. **Report** pass/fail with the real output. If a test fails, decide whether the test or the code is wrong — never weaken a test just to make it pass.

## Rules

- Cover the logic that would break, not every line. Minimal and meaningful.
- Don't add a new test framework unless the project has none and the user wants one.
- A test that can't fail is worthless — make sure each one would catch a real regression.
