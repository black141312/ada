---
name: squash
description: Squash a feature branch into one clean commit before merging
category: git
---

# Squash

Reach for this when a feature branch has many WIP/fixup commits and you want a single, well-described commit on the main history before merge.

1. Update the base so the squash sits on current code: `git fetch origin` then `git rebase origin/main` (resolve conflicts if any).
2. Count the commits to combine: `git log --oneline origin/main..HEAD`.
3. Squash interactively: `git rebase -i origin/main`, keep the first as `pick`, change the rest to `squash` (keeps their messages) or `fixup` (discards them).
4. Write one clear commit message in the editor that summarizes the whole change — subject line plus a body explaining the "why".
5. Alternatively, for a no-rebase squash: `git reset --soft origin/main` then a single `git commit` — collapses all changes into one staged commit.
6. Verify the tree is unchanged (`git diff origin/main` should match the branch's net effect) and tests pass, then `git push --force-with-lease`.
7. Or skip local squashing entirely and use GitHub's "Squash and merge" button if the repo enables it.

## Rules
- Squash only commits unique to your branch; never squash across commits others have based work on.
- Force-push the rewritten branch with `--force-with-lease`, never plain `--force`.
- Preserve the meaningful detail in the final message — don't reduce a real change to "fix stuff".
- `git reset --soft origin/main` is the simplest path when you just want everything as one commit and don't need to reorder.
- If the platform offers squash-merge, prefer it for shared branches so local history stays untouched.
