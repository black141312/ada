---
name: open-pr
description: Push the current branch and open a GitHub PR with a structured title and body.
---

# Open a PR

Requires `gh` authenticated (`gh auth status`) and a GitHub remote.

1. **Sanity-check.** `git status` should be clean — commit first if not. Confirm you're on a feature branch, not the repo's default branch. If on the default branch, create one: `git checkout -b <type>/<short-desc>`.
2. **Push.** `git push -u origin HEAD`.
3. **Summarize the change.** `git diff <base>...HEAD --stat` and the commit log since the base branch.
4. **Open the PR.** `gh pr create` with:
   - **Title** — a clear one-line summary (Conventional-Commits style is fine).
   - **Body** — three sections: **Summary** (what & why), **Changes** (bullets), **Test plan** (how it was verified).
5. **Return the PR URL** from `gh`.

## Rules

- Never merge as part of this — opening the PR is the end state.
- Confirm the base branch if there's any doubt; don't target the wrong one.
- Don't force-push over a shared branch.
- Keep the body honest: if something wasn't tested, say so in the test plan.
