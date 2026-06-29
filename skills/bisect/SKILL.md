---
name: bisect
description: Use git bisect to pinpoint the commit that introduced a regression
category: git
---

# Bisect

Reach for this when something worked before and is broken now, but you don't know which commit broke it. `git bisect` binary-searches history so you test ~log2(N) commits instead of all of them.

1. Reproduce the bug reliably and define a clear pass/fail test — ideally a single command that exits 0 when good, non-zero when bad.
2. Start the search: `git bisect start`, then mark the current broken state `git bisect bad`, and a known-good commit/tag `git bisect good <sha-or-tag>`.
3. At each step git checks out a midpoint commit; run your test and answer `git bisect good` or `git bisect bad` (use `git bisect skip` if a commit can't be tested, e.g. won't build).
4. Repeat until git prints "`<sha> is the first bad commit`" and shows that commit's details.
5. Inspect the culprit with `git show <sha>` to understand the regression, then `git bisect reset` to return to your original HEAD.
6. To fully automate, write a script that exits 0/non-zero and run `git bisect run ./test.sh` — git drives the whole search unattended.

## Rules
- The good/bad answers must be reliable; a flaky test will send bisect to the wrong commit.
- For `git bisect run`, your script must exit 125 for "skip/untestable", 0 for good, 1–124 for bad — not just any non-zero.
- Pick a `good` commit you're confident actually predates the bug, or the search range is wrong from the start.
- Always finish with `git bisect reset` to restore HEAD and clean up bisect state.
- If the breakage is environmental (deps, data) rather than in code, bisect will mislead you — confirm it's a code regression first.
