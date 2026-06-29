---
name: vendor
description: Vendor a tiny dependency into the repo to drop the package and its install/supply-chain cost
category: dependencies
---

# Vendor

Reach for this when a dependency is small enough that copying its source in beats carrying the package and its tree.

1. Confirm it's worth vendoring: the package is tiny, stable, and has few/no transitive deps — otherwise keep the dependency.
2. Check the license permits copying and note the requirement (attribution, header retention) for the vendored file.
3. Copy the minimal source you actually use into a clearly named `vendor/` (or `internal/`) path, preserving the license header.
4. Record provenance: a comment or NOTICE with the package name, version, source URL, and license.
5. Replace imports of the package with the local path, then remove the dependency from the manifest and lockfile.
6. Run tests and a build; reinstall clean to confirm the package is fully gone.

## Rules
- Only vendor small, slow-moving code — vendoring something that gets security patches means you now own those patches.
- Preserve the original license header and attribution; stripping it is a license violation.
- Pin the exact version you copied and write down where it came from for future updates.
- Trim to what you use, but don't refactor the vendored code — keep it diffable against upstream.
- After removing the dep, confirm nothing else (peer deps, types) still references it.
