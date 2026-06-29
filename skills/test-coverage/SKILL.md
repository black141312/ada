---
name: test-coverage
description: Find untested code paths in a module and add focused tests that exercise the real risk
category: testing
---

# Test Coverage

Use when a module is under-tested and you need to raise meaningful coverage, not just the percentage.

1. Run the suite with coverage reporting enabled and read the per-file line/branch numbers for the target module.
2. Open the coverage report and locate uncovered lines, especially error handling, early returns, and conditional branches.
3. Rank gaps by risk: prioritize logic that can fail in production over trivial getters or generated code.
4. Write a test for each high-risk path, naming it after the behavior it pins (not "test_function_2").
5. Cover the negative and edge cases — empty inputs, nulls, boundary values, thrown exceptions — not just the happy path.
6. Re-run coverage to confirm the lines are hit, then sanity-check that each new test actually asserts something.

## Rules
- Chase uncovered branches and behaviors, not a coverage number; 100% line coverage with weak asserts is worthless.
- Do not add tests that only call code without asserting on results or side effects.
- Skip testing third-party libraries and trivial pass-throughs; focus on your own logic.
- A surprising uncovered path often signals dead code — confirm it is reachable before testing it.
- Keep each test isolated; do not rely on order or shared mutable state to hit a path.
