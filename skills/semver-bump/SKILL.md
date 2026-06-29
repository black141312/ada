---
name: semver-bump
description: Bump the project version per semver, update changelog, and create the release tag
category: compliance
---

# Semver Bump

Reach for this when cutting a release and you need to choose the right version increment and tag it consistently.

1. Determine the bump from the changes since the last tag: MAJOR for breaking API changes, MINOR for backward-compatible features, PATCH for backward-compatible fixes (`git log <lastTag>..HEAD`).
2. Update the version in the source of truth (`package.json`, `pyproject.toml`, `Cargo.toml`, `VERSION`, etc.) and any places that mirror it.
3. Update `CHANGELOG.md`: move Unreleased entries under the new version with the date, grouped by Added/Changed/Fixed/Removed.
4. Commit with a clear message (e.g. `chore(release): v1.4.0`) on a release branch, not directly on a protected default branch.
5. Create an annotated, prefixed tag matching the repo convention: `git tag -a v1.4.0 -m "v1.4.0"`.
6. Push the commit and tag (`git push && git push --tags`) and open the PR / trigger the release pipeline.

## Rules
- A breaking change is MAJOR even if it feels small; never hide it in a MINOR/PATCH.
- Pre-1.0.0: treat MINOR as the place for breaking changes (the 0.y.z special case) per semver.
- Keep the tag format consistent with existing tags (`v`-prefixed or not) — check `git tag` first.
- Use annotated tags (`-a`) so the tag carries metadata; lightweight tags break some release tooling.
- Don't reuse or move a published tag; if wrong, cut a new version rather than rewriting history.
- Bump the version and changelog in the same commit so the tag points at a coherent state.
