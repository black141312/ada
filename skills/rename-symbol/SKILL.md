---
name: rename-symbol
description: Rename a variable, function, type, or file safely across the whole project
category: refactoring
---

# Rename Symbol

Use when a name is misleading, stale, or inconsistent. The goal is a complete rename with zero dangling references and no accidental collateral hits.

1. Prefer a language-aware rename (LSP/IDE "rename symbol") so only real references change, not text matches.
2. If renaming by search, scope it: match word boundaries and the correct case, and review every hit before applying.
3. Update all sites — definitions, call sites, imports/exports, type annotations, and string references (DI keys, serialized names, configs).
4. Check dynamic/reflective uses: JSON keys, ORM column maps, reflection, templates, docs, and comments.
5. Build and run tests to catch missed or wrongly-changed references.
6. Grep once more for the old name to confirm only intentional leftovers remain.

## Rules
- Beware short or common names (`id`, `data`) — text search will over-match; use semantic rename only.
- Renaming a serialized field, DB column, env var, or public API name is a behavior change, not a pure refactor — flag it.
- Keep the rename in its own commit so the diff is auditable.
- If a public/exported symbol must keep backward compatibility, add an alias/deprecation rather than breaking callers.
- Don't forget filenames and the imports that reference them when renaming modules.
