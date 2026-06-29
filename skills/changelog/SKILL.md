---
name: changelog
description: Maintain a CHANGELOG following keep-a-changelog with an Unreleased section and semver
category: docs
---

# Changelog

Use this to add or update a CHANGELOG.md so users can see what changed between releases at a glance. Follow the keep-a-changelog convention.

1. Create or open CHANGELOG.md; ensure an `## [Unreleased]` section sits at the top.
2. Group entries under the standard headings: Added, Changed, Deprecated, Removed, Fixed, Security.
3. Write each entry from the user's perspective — what changed and its impact, not the commit message.
4. On release, rename `[Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and start a fresh empty Unreleased.
5. Choose the version bump by semver: breaking → major, feature → minor, fix → patch.
6. Add link references at the bottom comparing tags (e.g. `[x.y.z]: .../compare/vA...vB`).
7. Confirm dates use ISO `YYYY-MM-DD` and the newest version is listed first.

## Rules
- Write for humans reading releases, not a `git log` dump — one bullet per notable change.
- Keep an Unreleased section always present so contributors have somewhere to add notes.
- Use the six canonical categories; omit empty ones rather than leaving blank headers.
- Newest entries on top; never rewrite history of already-released versions.
- Bump version per semver and keep dates ISO-formatted.
