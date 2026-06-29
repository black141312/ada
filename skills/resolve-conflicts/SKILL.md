---
name: resolve-conflicts
description: Work through merge or rebase conflicts safely without losing either side's intent
category: git
---

# Resolve Conflicts

Use this when a merge, rebase, cherry-pick, or stash pop stops with conflicts. The goal is a result that preserves the intent of both sides, not just one that compiles.

1. See the lay of the land: `git status` lists conflicted files; `git diff` shows the conflict markers in context.
2. Understand both sides before editing: `git log --merge -p <file>` or `git show :1:<file>`/`:2:`/`:3:` to inspect base, ours, and theirs.
3. Edit each file to a correct merged result — delete the `<<<<<<<`, `=======`, `>>>>>>>` markers and reconcile the logic, not just pick a side.
4. Mark resolved: `git add <file>` per file. To take one side wholesale use `git checkout --ours <file>` or `--theirs <file>` (note: in a rebase, ours/theirs are swapped vs a merge).
5. Continue the operation: `git merge --continue` / `git rebase --continue` / `git cherry-pick --continue`. To bail out, use the matching `--abort`.
6. Verify before trusting: build and run tests, since a conflict resolution can be syntactically clean but semantically wrong.

## Rules
- Read both sides' intent before resolving; a merge that drops one side's logic is a silent bug.
- Remember ours/theirs is inverted during rebase (you're replaying your commits onto theirs) — verify with `git diff` rather than guessing.
- Always run the test suite after resolving; clean markers do not mean correct behavior.
- Use `git merge --abort` (or rebase/cherry-pick `--abort`) to get back to a known-good state instead of half-fixing.
- Enable `git config rerere.enabled true` to auto-reuse recorded resolutions on repeated conflicts (e.g. long rebases).
