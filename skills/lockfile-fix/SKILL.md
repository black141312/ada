---
name: lockfile-fix
description: Resolve lockfile drift or merge conflicts by regenerating the lockfile from the manifest
category: dependencies
---

# Lockfile Fix

Reach for this when the lockfile is out of sync with the manifest or has merge-conflict markers after a rebase/merge.

1. Identify the manager and its lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `uv.lock`).
2. For a merge conflict, take the manifest's resolution first — accept both sides of the manifest, then discard the conflicted lockfile body.
3. Regenerate from the manifest: `npm install`, `pnpm install`, `yarn install`, `cargo generate-lockfile`, `poetry lock`, `uv lock` — never resolve lockfile markers by hand.
4. Verify the manifest itself merged cleanly and reflects the intended versions before regenerating.
5. Reinstall clean (`npm ci`) to prove the new lockfile resolves and the tree installs.
6. Commit the regenerated lockfile alongside the manifest and run tests.

## Rules
- Never hand-edit conflict markers in a lockfile; delete the conflicted content and regenerate.
- Resolve the manifest first — the lockfile is derived, not authoritative.
- Use the same package-manager version as the team/CI; a different version can rewrite the whole lockfile.
- Run a clean install (`ci`/frozen) afterward to catch an unsatisfiable resolution early.
- Keep the regenerated lockfile and manifest in one commit so the pair stays consistent.
