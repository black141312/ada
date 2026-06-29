---
name: dedupe-deps
description: Remove duplicate and unused dependencies to shrink install size and the dependency tree
category: dependencies
---

# Dedupe Deps

Use when the dependency tree has bloated — duplicate versions of the same package, or declared deps nothing imports.

1. Flatten duplicate versions where the manager allows it (`npm dedupe`, `pnpm dedupe`, `yarn dedupe`) and inspect the resulting tree.
2. Find unused declared deps with a tool (`depcheck`, `knip`, `cargo-udeps`, `pip-autoremove --dry-run`) and cross-check each hit by grepping imports.
3. Confirm anything flagged isn't used only at runtime, in config, in scripts, or by a build/CI step before removing it.
4. Move build-only and test-only packages into devDependencies (or the equivalent) so production installs stay lean.
5. Remove the confirmed-dead entries, regenerate the lockfile, and reinstall clean.
6. Run the full test suite and a production build to prove nothing relied on the removed packages.

## Rules
- Treat automated "unused" reports as suspects, not verdicts — verify each before deleting.
- Watch for deps referenced only in strings, config files, CLI scripts, or dynamic imports that scanners miss.
- Distinguish a genuinely unused dep from a duplicated version; they need different fixes.
- Don't delete a transitive dep directly — remove the top-level package that pulls it in.
- Re-run the build after deduping; flattening can surface a peer-dependency conflict.
