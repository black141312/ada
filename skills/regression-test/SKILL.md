---
name: regression-test
description: Reproduce a reported bug as a failing test before fixing it, so it can never silently return
category: testing
---

# Regression Test

Use when fixing a reported bug: capture it as a failing test first so the fix is proven and the bug stays dead.

1. Reproduce the bug manually and nail down the exact inputs, state, and steps that trigger it.
2. Write a test that reproduces it at the lowest practical level (unit if possible, integration/E2E if it needs the stack).
3. Run the test and confirm it FAILS, demonstrating the bug — the failure should match the reported symptom.
4. Implement the fix and run the test until it passes; confirm the failure mode is genuinely gone.
5. Run the surrounding suite to make sure the fix didn't break anything else.
6. Commit the test together with the fix, referencing the bug/issue id so the link is permanent.

## Rules
- Write the failing test before the fix; a fix without a failing test first proves nothing about the bug.
- The test must fail for the bug's actual reason — verify it goes red on unfixed code, not on a setup error.
- Reproduce at the narrowest level that still captures the bug; reserve E2E for bugs that only appear there.
- Name the test after the bug/symptom (and issue id) so future readers know why it exists.
- Keep the regression test even if it overlaps existing tests; it documents a specific past failure.
