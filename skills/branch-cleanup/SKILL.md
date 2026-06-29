---
name: branch-cleanup
description: Prune merged and stale local and remote branches safely
category: git
---

# Branch Cleanup

Use this to clear out branches that have already merged or gone stale, keeping the branch list readable without deleting unmerged work.

1. Sync references first: `git fetch --prune` to update remotes and drop refs for branches deleted on the remote.
2. List merged branches: `git branch --merged main` shows locals fully merged into main (safe to delete); review the list before acting.
3. Delete merged locals: `git branch -d <name>` (the lowercase `-d` refuses to delete unmerged branches, which is the safety you want).
4. Find stale branches: `git branch -vv` flags ones whose upstream is `[gone]`, and `git for-each-ref --sort=committerdate refs/heads --format='%(committerdate:short) %(refname:short)'` surfaces the oldest.
5. Clean remotes deliberately: `git push origin --delete <name>` for branches you own and confirm are merged; don't delete others' active branches.
6. Re-check `git branch --merged` and `git branch` to confirm only intended branches remain.

## Rules
- Use `git branch -d` (safe) not `-D` (force) unless you've verified the branch is truly disposable — `-D` discards unmerged commits.
- Exclude protected branches (`main`, `develop`, release/*) from any bulk delete; filter them out explicitly.
- `git fetch --prune` only cleans remote-tracking refs, not local branches — do both steps.
- Confirm a remote branch is merged and unowned by an active developer before `--delete`.
- Recover an accidentally-deleted branch via `git reflog` / `git checkout -b <name> <sha>` while the object is still reachable.
