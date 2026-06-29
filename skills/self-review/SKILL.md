---
name: self-review
description: Run a pre-PR self-review checklist over your own changes before opening the PR
category: review
---

# Self Review

Use this right before you open a PR or hand off work — read your own diff as a skeptical reviewer would, catching the obvious stuff before someone else does.

1. Run `git diff main...HEAD` and read every hunk top to bottom as if you'd never seen it.
2. Confirm the diff is scoped: no stray debug prints, commented-out code, leftover TODOs, or unrelated reformatting.
3. Check the change actually does what the task asked — re-read the requirements and map each one to a line in the diff.
4. Verify edge cases and error paths are handled (empty input, nulls, failures, concurrency) and that new behavior has tests.
5. Run the build, linter, formatter, and test suite; fix anything red before proceeding.
6. Review the commit messages and PR description for clarity, then list any follow-ups you're deliberately deferring.

## Rules
- Read the whole diff, not just the files you remember editing — staging mistakes hide in the rest.
- Be your own harshest reviewer; if a line would draw a comment from a teammate, fix it now.
- Don't claim tests pass without actually running them and seeing green output.
- Keep unrelated cleanups out of the PR — file them separately so the diff stays reviewable.
- If something is intentionally incomplete, call it out explicitly rather than hoping nobody notices.
