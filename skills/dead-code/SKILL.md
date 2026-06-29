---
name: dead-code
description: Find and remove unused code, exports, and files across the project
category: review
---

# Dead Code

Use this to clean out code that nothing references anymore — unreachable branches, unused exports, orphaned files, and stale dependencies that quietly accrue.

1. Run the language's dead-code tooling first (e.g. `ts-prune`/`knip`, `unimport`, `vulture`, `cargo +nightly udeps`, compiler `-Wunused`, or IDE "unused" inspections).
2. For each candidate, grep the whole repo for the symbol — including dynamic references, string-based lookups, reflection, and test-only usage — before deleting.
3. Remove unreachable branches, commented-out blocks, unused params, and exports no longer imported anywhere.
4. Delete orphaned files and prune dependencies in the manifest that nothing imports.
5. Run the build, type-checker, and full test suite after each batch of deletions to confirm nothing broke.
6. Commit the removals in a focused, behavior-preserving commit separate from any feature work.

## Rules
- Verify a symbol is truly unreferenced before deleting — dynamic dispatch, DI containers, and string keys evade static analysis.
- Keep public API surface intact unless you've confirmed no external consumer depends on it; deprecate before deleting when unsure.
- Don't delete code guarded by feature flags, platform conditionals, or build targets you're not exercising.
- Make deletions in small, reviewable commits so a regression is easy to bisect and revert.
- Tests and fixtures count as usage — don't delete code only the tests use unless you're removing the tests too.
