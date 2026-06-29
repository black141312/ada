---
name: release-notes
description: Generate release notes from commits since the last tag
category: git
---

# Release Notes

Use this to draft a changelog for a new release by collecting and grouping the commits made since the previous tag.

1. Find the last release point: `git describe --tags --abbrev=0` gives the most recent tag to diff against.
2. Collect the commits: `git log <last-tag>..HEAD --oneline --no-merges` (or `--pretty=format:'- %s (%h) @%an'` for richer lines).
3. Group by type: bucket commits into Features / Fixes / Performance / Docs / Breaking Changes — Conventional Commit prefixes (`feat:`, `fix:`) make this mechanical.
4. Surface breaking changes prominently: scan for `BREAKING CHANGE` in bodies (`git log <last-tag>..HEAD --grep='BREAKING'`) and call them out at the top.
5. Enrich with PR/issue links where useful and credit contributors (`git shortlog -sn <last-tag>..HEAD`).
6. Write the notes top-down: highlights first, then grouped lists, then a full commit/PR reference; tag the release and attach.
7. For a fully-automated draft, `gh release create <tag> --generate-notes` uses GitHub's auto-generated notes as a starting point.

## Rules
- Diff from the actual last tag, not an arbitrary date — `git describe --tags --abbrev=0` is the source of truth.
- Exclude merge commits (`--no-merges`) so the list reads as real changes.
- Lead with breaking changes and user-facing features; bury internal/chore commits or omit them.
- Rewrite terse commit subjects into user-readable lines — release notes are for humans, not a raw `git log` dump.
- Verify the tag/range covers exactly the intended release; an off-by-one tag drops or duplicates entries.
