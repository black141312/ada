---
name: split-file
description: Break a large file into focused modules without changing behavior
category: refactoring
---

# Split File

Use when a file has grown to mix several responsibilities and is hard to navigate or test. Split along seams that already exist, not arbitrary line counts.

1. Map the file's contents into groups by responsibility (types, helpers, one cohesive feature each).
2. Identify the dependency direction between groups so new modules don't create import cycles.
3. Move one group at a time into a new module, keeping names intact to minimize churn.
4. Add imports/exports; update every external reference to point at the new location.
5. Optionally keep the original file as a thin barrel that re-exports, to avoid touching many call sites at once.
6. Build and run tests after each move; commit per extracted module.

## Rules
- Split by responsibility, not by size — a 600-line file with one clear job may be fine as is.
- Watch for circular imports; if two new modules need each other, the seam is wrong — extract shared parts to a third.
- Keep public exports stable, or update all importers in the same change.
- Don't relocate code and edit its logic in the same step; move first, then refactor.
- Preserve file-level side effects (registration, init order) — moving them can change runtime behavior.
