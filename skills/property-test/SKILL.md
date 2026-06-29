---
name: property-test
description: Add property-based tests that assert invariants across generated inputs instead of fixed examples
category: testing
---

# Property Test

Use when a function has properties that must hold for all inputs, and example-based tests miss edge cases.

1. State the invariant in plain language (e.g. "decode(encode(x)) == x", "output is always sorted", "result never negative").
2. Pick a property-based library for the language (Hypothesis, fast-check, QuickCheck) and define a generator for the input domain.
3. Express the property as a test: generate inputs, run the code, assert the invariant holds for every case.
4. Constrain generators to valid inputs only (filters/preconditions) so failures reflect real bugs, not invalid data.
5. Run it; when it finds a failure, let the framework shrink to the minimal counterexample and inspect that case.
6. Fix the bug, then pin the shrunk counterexample as an explicit regression example test.

## Rules
- Test true invariants — round-trips, idempotence, ordering, conservation — not restatements of the implementation.
- Make generators match the real input domain; over-broad generators produce noise, over-narrow ones miss bugs.
- Always capture the shrunk counterexample as a permanent example-based regression test once fixed.
- Seed the RNG or record failing seeds so a found failure is reproducible, not a one-off in CI.
- Keep run counts reasonable in CI; raise iterations for a focused hunt, not on every commit.
