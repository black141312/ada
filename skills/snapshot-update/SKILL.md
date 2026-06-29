---
name: snapshot-update
description: Review snapshot test diffs and update them intentionally, never blindly accepting all
category: testing
---

# Snapshot Update

Use when snapshot tests fail after a change and you need to decide which diffs are intended versus regressions.

1. Run the snapshot tests and read each failing diff in full before touching the snapshot files.
2. For every diff, decide deliberately: is this the change I intended, or did I break something I didn't mean to?
3. Fix the code for any unintended diff; only update the snapshot for diffs that reflect intended behavior.
4. Update accepted snapshots (e.g. `--update`/`-u`) and re-run to confirm the suite is green.
5. Open the snapshot file changes in the diff and review them like any other code change before committing.
6. Commit the snapshot updates alongside the code change that justifies them, with a message explaining why.

## Rules
- Never run a blanket "update all snapshots" without reading every diff — that turns the test into a rubber stamp.
- A snapshot diff you can't explain is a regression until proven otherwise; investigate, don't accept.
- Keep snapshots small and focused; giant snapshots hide meaningful diffs in noise — prefer targeted assertions for logic.
- Commit snapshot updates with the change that caused them, never as a separate "fix snapshots" cleanup later.
- Scrub nondeterministic values (timestamps, ids, paths) from snapshots so they don't churn on every run.
