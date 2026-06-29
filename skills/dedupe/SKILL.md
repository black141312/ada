---
name: dedupe
description: Collapse duplicated logic into a single shared implementation
category: refactoring
---

# Dedupe

Use when the same logic appears in two or more places and they must stay in sync. Unify only genuine duplication, not code that merely looks similar.

1. Locate all copies and diff them carefully to find the real differences (params, edge cases, ordering).
2. Confirm the duplicates represent the same concept — if they drift for different reasons, leave them apart.
3. Extract the shared core into one function/module; express the differences as parameters or hooks.
4. Replace each copy with a call to the shared implementation.
5. Run tests across every former call site, including the edge cases each copy handled.
6. Commit, and note any intentional remaining near-duplicates and why.

## Rules
- Don't force unification when the only commonality is shape — premature abstraction is worse than duplication (WET beats a wrong DRY).
- If copies differ subtly, decide deliberately which behavior is correct; merging can silently pick one and change the other.
- Keep the shared abstraction at the right layer so callers don't gain an awkward dependency.
- Avoid a parameter explosion; if the unified function needs many flags to cover variants, the abstraction is wrong.
- Verify each original edge case still works after merging — that's where dedupe bugs hide.
