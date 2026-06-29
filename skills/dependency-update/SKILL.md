---
name: dependency-update
description: Bump dependencies safely, regenerate the lockfile, and confirm the test suite still passes
category: dependencies
---

# Dependency Update

Reach for this when bumping one or many dependencies and you want to land the change without breaking the build.

1. Snapshot the current state: note the green test/build baseline and capture the manifest + lockfile in git so you can diff later.
2. List what is outdated (`npm outdated`, `pip list --outdated`, `cargo update --dry-run`) and separate patch/minor from major bumps.
3. Bump in small batches — patches and minors first, one risky major at a time — and regenerate the lockfile deterministically.
4. Read the changelog/release notes for any major bump and apply required code or config migrations.
5. Run install clean (`npm ci`, `pip install -r` in a fresh venv) plus the full test suite and a build.
6. Commit the manifest and lockfile together with a message naming the packages and version ranges.

## Rules
- Never edit the lockfile by hand — let the package manager regenerate it.
- Pin majors and review them individually; a batched major bump hides which one broke things.
- Run a clean install, not an incremental one, so a stale cache doesn't mask a resolution problem.
- If tests fail, bisect the batch rather than reverting everything; isolate the offending package.
- Keep manifest and lockfile changes in the same commit so CI never sees a drifted pair.
