---
name: tdd
description: Drive a feature with a red-green-refactor loop, writing the failing test before any implementation
category: testing
---

# TDD

Reach for this when building a new feature or behavior and you want tests to define the contract before code exists.

1. Pick the smallest next behavior and write one test that asserts it; do not write implementation yet.
2. Run the test and confirm it fails for the expected reason (assertion, not a typo or import error) — this is RED.
3. Write the minimum code to make that test pass; resist adding anything the test doesn't demand.
4. Run the full test file and confirm GREEN; if other tests broke, fix them before moving on.
5. Refactor names, duplication, and structure with tests green as a safety net; re-run after each change.
6. Commit the green increment, then loop back to the next behavior.

## Rules
- One behavior per cycle; never write a second test while the first is red.
- A test that passes on its first run is suspect — make it fail first to prove it tests something.
- Keep implementation minimal; "fake it till you make it" (hardcode, then generalize) is valid early.
- Refactor only on green, never while red, and never mix a refactor with new behavior in one commit.
- If a test is hard to write, treat it as a design smell and reconsider the interface before forcing it.
