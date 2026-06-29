---
name: bundle-analyze
description: Analyze the production bundle to find the heaviest modules and shrink the shipped size
category: dependencies
---

# Bundle Analyze

Use when the shipped bundle is too large and you need to know what is taking up space before cutting it.

1. Produce a production build with stats enabled and open a treemap (`webpack-bundle-analyzer`, `vite-bundle-visualizer`, `source-map-explorer`, `rollup-plugin-visualizer`).
2. Rank modules by gzipped size and flag the worst offenders — large libs, duplicated packages, and accidentally-bundled dev/test code.
3. Replace heavy dependencies with lighter or native equivalents (e.g. date helpers, lodash → per-method or stdlib).
4. Split routes and lazy-load rarely-used chunks; defer anything not needed for first paint.
5. Ensure tree-shaking works: prefer ESM imports, drop side-effect-y barrel files, and set `sideEffects` correctly.
6. Rebuild, compare gzipped sizes against the baseline, and record the before/after numbers.

## Rules
- Measure gzipped (or brotli) size, not raw bytes — that's what users actually download.
- Always analyze a production build; dev builds include unminified helpers and skew the picture.
- Confirm a smaller alternative is genuinely lighter after tree-shaking, not just on paper.
- Duplicated versions of one library are a common, easy win — dedupe before swapping libs.
- Re-run the analyzer after each change so you attribute the savings correctly.
