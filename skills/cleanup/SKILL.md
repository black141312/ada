---
name: cleanup
description: Sweep repo hygiene — fix .gitignore gaps, remove dead files, and triage stray TODOs and debug cruft
category: meta
---

# Cleanup

Reach for this for a focused hygiene pass before a release or after a messy spike: tighten ignores, delete cruft, and surface lingering TODOs without touching real logic.

1. Audit ignores: check `git status` and `git ls-files` for committed build artifacts, `node_modules`, `dist`/`build`, caches, `.env`, and editor files; add the missing patterns to `.gitignore`.
2. Untrack already-committed junk with `git rm -r --cached <path>` (keeps the working copy) so the new ignore rules take effect.
3. Find dead files: locate unreferenced modules, `.bak`/`.orig`/`.tmp`/`.DS_Store`, empty dirs, and commented-out code blocks; confirm each is unreferenced via grep before removing.
4. Triage markers: grep for `TODO`, `FIXME`, `XXX`, `console.log`/`print`/`dbg!` debug statements and stray breakpoints; remove debug cruft, and file or annotate real TODOs.
5. Sanity-check that nothing broke: run the build, tests, and linter after deletions.
6. Commit in small, labeled chunks (e.g. `chore: gitignore`, `chore: remove dead files`) so the sweep is easy to review and revert.

## Rules
- Never delete a file until grep/usage search confirms nothing references it — when unsure, leave it and note it.
- Keep functional changes out of this sweep; hygiene only, so the diff stays trivially reviewable.
- Don't blanket-strip all TODOs — preserve meaningful ones (convert to issues or keep with context).
- Verify `.env` and secrets are ignored and untracked; if a secret was ever committed, flag it for rotation, not just removal.
- Run the full build/test/lint after removals and before committing — a hygiene sweep must not break the build.
