---
name: modernize
description: Update code to current language idioms, APIs, and syntax without changing behavior
category: refactoring
---

# Modernize

Use when code relies on dated patterns, deprecated APIs, or verbose syntax that a newer language/runtime version expresses better. Improve readability and remove deprecation warnings.

1. Check the project's actual language/runtime version and lint/compiler target — don't use syntax it can't run.
2. Inventory the dated patterns (callbacks→async/await, var→const/let, manual loops→map/filter, format strings, optional chaining).
3. Replace deprecated APIs with their supported equivalents, checking semantics (some replacements differ on edge cases).
4. Apply changes incrementally by pattern; lean on codemods or autofixers where they exist.
5. Run the linter and full test suite after each pattern batch.
6. Update any related config (compiler target, polyfills, engine field) so the modernized code is actually supported.

## Rules
- Match the project's existing style and version; modernizing past what CI supports breaks the build.
- Some "equivalents" aren't exact (e.g. `Promise.all` vs sequential awaits, `==` vs `===`) — verify behavior, not just shape.
- Don't bundle dependency upgrades into the same change unless required; keep concerns separate.
- Prefer mechanical, reviewable batches over a single sweeping rewrite.
- Leave intentionally-old patterns alone if a comment or constraint explains them.
