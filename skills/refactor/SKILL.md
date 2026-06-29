---
name: refactor
description: Make a safe, behavior-preserving refactor with tests green at every step
category: refactoring
---

# Refactor

Reach for this when you want to improve structure, names, or design without changing observable behavior. The contract: every commit compiles and passes tests.

1. Establish a baseline — run the test suite and confirm it is green before touching anything.
2. If coverage is thin around the target code, add characterization tests that pin current behavior first.
3. Make one small structural change at a time (extract, rename, move, inline); avoid mixing in behavior changes.
4. Re-run the relevant tests after each change; if red, revert that step rather than debugging forward.
5. Commit each green step separately with a message describing the structural move.
6. When done, diff against the start and verify no public API, output, or side effect changed.

## Rules
- Never refactor and fix a bug or add a feature in the same commit — split them.
- If the suite is too slow, run a fast subset per step and the full suite before pushing.
- Keep the diff reviewable; a refactor PR with logic changes hiding inside is a trap.
- If tests are missing and can't be added cheaply, say so and proceed with extra caution, not silently.
- Prefer mechanical, tool-assisted transforms (IDE/LSP rename, AST codemods) over hand edits.
