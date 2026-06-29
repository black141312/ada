---
name: tree-shake
description: Eliminate unused imports and exports so dead code is dropped from the bundle
category: dependencies
---

# Tree Shake

Reach for this when dead code is shipping because imports/exports aren't being eliminated by the bundler.

1. Run a static analyzer (`knip`, `ts-prune`, ESLint `no-unused-vars`/`unused-imports`) to list unused imports and unreferenced exports.
2. Remove unused imports and delete or stop exporting symbols nothing consumes.
3. Replace whole-module/namespace imports with named imports so the bundler can drop the rest.
4. Break up barrel (`index.ts` re-export) files or mark them side-effect-free so importing one symbol doesn't pull the whole directory.
5. Set `"sideEffects": false` (or an explicit file list) in package.json and keep the build target ESM.
6. Rebuild and confirm the removed code is gone from the output via the bundle analyzer.

## Rules
- Don't remove an export that's part of the public API just because it's unused internally.
- Watch for imports kept only for side effects (polyfills, CSS, registrations) — flagging `sideEffects: false` wrongly drops them.
- Named imports tree-shake; `import * as x` and default-object imports usually don't.
- Barrel files defeat tree-shaking in many bundlers — import from the source module directly.
- Verify the result in the actual build output, not just the linter — analysis and bundling differ.
