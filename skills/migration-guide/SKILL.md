---
name: migration-guide
description: Write an upgrade/migration guide between versions with breaking changes, before/after diffs, and a checklist.
category: docs
---

# Migration Guide

Use when a release breaks compatibility and users need a clear path from version X to Y — the difference between a smooth upgrade and a flood of issues.

1. Open with scope: which versions this covers (`v2 → v3`), who is affected, and rough effort/risk.
2. List breaking changes as a scannable table: what changed, why, and what to do — ordered by how likely each is to bite.
3. For each change, show a concrete before/after diff (old API call → new API call), not just prose.
4. Provide a step-by-step migration checklist the reader can follow top to bottom, including how to run things in compat mode if available.
5. Document automated help: codemods, `--fix` flags, or scripts that do the mechanical edits.
6. Note deprecations (still works, will be removed in Z) separately from hard breaks.
7. Add a rollback path and a "verify the upgrade" step so users can confirm success.

## Rules
- Lead with breaking changes; nice-to-have features go at the bottom or in the changelog.
- Every break needs a before/after code example — telling someone "the API changed" isn't a migration guide.
- Separate "must change now" (breaks) from "should change soon" (deprecations).
- Ship a codemod/script for mechanical changes when feasible; don't make humans do find-replace at scale.
- Test the guide by actually upgrading a sample project against it before publishing.
