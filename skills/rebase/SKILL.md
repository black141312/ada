---
name: rebase
description: Clean up branch history with interactive rebase without rewriting shared commits
category: git
---

# Rebase

Use this to tidy a feature branch's history — reorder, reword, fixup, or drop commits, or replay onto an updated base — while keeping commits that others have already pulled intact.

1. Confirm the branch is yours and unshared, or that collaborators agree to a force-push; never rewrite history on `main`/shared branches.
2. Snapshot a safety net: note the current SHA (`git rev-parse HEAD`) or create a backup branch (`git branch backup/<name>`) so you can recover.
3. Update the base first: `git fetch origin` then `git rebase origin/main` (or `git rebase -i origin/main` to also clean history in one pass).
4. In interactive mode pick actions per line — `reword`, `squash`/`fixup`, `edit`, `drop`, reorder — keeping the oldest commit at the top.
5. Resolve any conflicts as they surface: fix files, `git add`, then `git rebase --continue`; use `git rebase --abort` to bail back to the pre-rebase state.
6. Verify the result: `git log --oneline origin/main..HEAD` and run tests, since rebasing can silently break a previously-working intermediate state.
7. Publish with `git push --force-with-lease` (safer than `--force`: it refuses if the remote moved unexpectedly).

## Rules
- Only rebase commits that exist solely on your local/feature branch; rebasing pushed-and-pulled commits breaks teammates.
- Always force-push with `--force-with-lease`, never plain `--force`.
- Keep a backup branch or recorded SHA before starting; `git reflog` is your fallback if you skipped that.
- Resolve conflicts commit-by-commit — don't blindly `git checkout --theirs/--ours` without understanding each.
- If a rebase gets messy, `git rebase --abort` and reconsider rather than fighting it.
