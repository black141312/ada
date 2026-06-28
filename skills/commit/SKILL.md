---
name: commit
description: Stage changes and write a clean Conventional Commits message, then commit.
---

# Commit

Create a well-formed commit for the current changes.

1. **Understand the change.** Run `git status` and `git diff` (both staged and unstaged). Read the whole change before writing anything.
2. **Stage intentionally.** `git add -A` for everything, or specific paths when the working tree mixes unrelated work. Never commit unrelated changes together.
3. **Write a Conventional Commits message:**
   - `type(scope): subject` — type is one of `feat` `fix` `docs` `refactor` `test` `chore` `perf` `build` `ci`. Scope is optional.
   - Subject: imperative mood ("add", not "added"), ≤ ~72 chars, no trailing period.
   - Body (optional; blank line first): explain *what* and *why*, not *how*. Wrap ~72 cols.
4. **Commit.** `git commit -m "..."` — use a heredoc for multi-line bodies.
5. **Confirm.** `git log --oneline -1`.

## Rules

- One logical change per commit.
- Check `git status` first — never commit secrets, build output, or `node_modules`.
- Don't `git add .` blindly when untracked junk is present.
- Don't amend or force-push unless explicitly asked.
- If on the repository's default branch and about to commit feature work, ask whether to branch first.
