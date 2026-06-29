---
name: component
description: Scaffold a reusable UI component with typed props, variants, and explicit loading/empty/error states
category: frontend
---

# Component

Reach for this when adding a new reusable UI component that other parts of the app will compose, not a one-off page section.

1. Define the component's contract first: required vs optional props, their types, and sensible defaults; prefer a small surface over a kitchen-sink config.
2. Place the file next to siblings following the repo's existing convention (folder-per-component or flat); match casing, file extension, and export style of neighbors.
3. Implement the markup with semantic elements and forward `className`/`style` and a `ref` where the host element is interactive.
4. Model variants and sizes as discrete props (e.g. `variant`, `size`) mapped to classes, not as free-form style overrides.
5. Handle the non-happy paths explicitly: loading, empty, disabled, and error renders — never assume data is present.
6. Add a usage example or story plus a minimal test that renders the component and asserts key props/states.

## Rules
- Keep components presentational; lift data fetching and side effects to a parent or hook.
- Type every prop; avoid `any` and avoid spreading untyped `...props` onto the DOM.
- Don't hardcode colors, spacing, or copy — pull from tokens/theme and pass text via props or children.
- One responsibility per component; if it grows branches, split it.
- Mirror existing naming and folder patterns instead of inventing a new structure.
