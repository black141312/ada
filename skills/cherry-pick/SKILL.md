---
name: cherry-pick
description: Backport a specific commit onto another branch with git cherry-pick
category: git
---

# Cherry-Pick

Reach for this when one commit (a fix, a hotfix) needs to land on another branch — e.g. backporting a `main` fix to a release branch — without merging everything else.

1. Identify the exact commit(s): `git log --oneline <source-branch>` and copy the SHA(s); for a range use `A^..B` (note the `^` to make it inclusive of A).
2. Switch to the target branch and make sure it's clean and current: `git checkout release/x` then `git pull`.
3. Apply it: `git cherry-pick <sha>` (or multiple SHAs / a range). Add `-x` to append a "cherry picked from ..." line for traceability.
4. If it conflicts, resolve the files, `git add` them, then `git cherry-pick --continue`; use `--abort` to back out cleanly.
5. Verify the change makes sense on the target — dependencies the commit relied on may not exist there — and run tests.
6. Push the target branch and, if backporting a fix, reference the original PR/commit so reviewers can trace lineage.

## Rules
- Use `-x` when backporting so the new commit records its origin SHA.
- Cherry-picking creates a new SHA; don't expect it to match the source, and avoid later merging the same change twice (can cause conflicts).
- For a contiguous range remember `A^..B` includes A; plain `A..B` excludes it.
- If a commit depends on earlier commits not on the target branch, cherry-pick those too or expect conflicts/breakage.
- Prefer cherry-picking small, self-contained commits; large entangled ones are better merged.
