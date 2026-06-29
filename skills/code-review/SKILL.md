---
name: code-review
description: Review the current git diff for correctness bugs and quality/simplification issues.
category: review
---

# Code review

Review the pending changes on this branch and report findings — don't rewrite code unless asked.

1. **Get the diff.** `git diff` (unstaged) and `git diff --staged`, or `git diff <base>...HEAD` to review a whole branch. Read the full diff before judging anything.
2. **For each hunk, check:**
   - **Correctness** — logic errors, off-by-one, null/undefined, missing error handling, unhandled edge cases (empty, boundary, large), race conditions, resource leaks.
   - **Security** — injection, path traversal, secrets committed in code, unvalidated input at trust boundaries.
   - **Quality** — duplication, dead code, unclear names, reinvented standard library, needless complexity or abstraction.
3. **Report** as a list, each item: `file:line — what's wrong — suggested fix`. Order by severity, bugs first.
4. Be high-signal: skip pure style nits unless asked. If the diff is clean, say so plainly.

## Rules

- Verify before asserting — trace the actual code path; don't guess.
- Distinguish "this is a bug" from "I'd prefer". Mark confidence when unsure.
- After reporting, offer to fix the confirmed issues.
