---
name: simplify-conditionals
description: Flatten nested or complex branches using guard clauses and early returns
category: refactoring
---

# Simplify Conditionals

Use when branching is deeply nested, hard to follow, or buried in negations. The aim is to make the happy path obvious and edge cases explicit.

1. Identify the failure/edge conditions and convert them into guard clauses that return early at the top.
2. Flatten the remaining nesting so the main logic sits at the lowest indentation level.
3. Replace negated and compound conditions with positively-named boolean variables or small predicates.
4. Collapse redundant branches (duplicate arms, dead `else`, unreachable cases) and consider a lookup table for long if/else chains.
5. Confirm the truth table is unchanged — every input still hits the same outcome.
6. Run tests, especially around boundary and short-circuit cases.

## Rules
- Early returns must preserve any cleanup that ran in the original tail — watch for finally/teardown.
- Don't change short-circuit order if conditions have side effects or guard against null/undefined.
- Keep guard clauses for true exceptions only; don't shove core logic into early returns.
- Extract a complex condition into a well-named helper rather than commenting it.
- Re-verify de Morgan transforms (`!(a && b)` ↔ `!a || !b`) — these are an easy place to flip behavior.
