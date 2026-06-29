---
name: component-library
description: Build a reusable, composable, accessible component library in the shadcn/ui style with design tokens.
category: ui-design
---

# Component Library

Reach for this when an app has accumulated copy-pasted, drifting UI and needs one coherent, themeable set of primitives that compose cleanly.

1. Establish the token layer first: define semantic CSS custom properties (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--ring`, radii, spacing) so theming/dark mode is a variable swap, not a rewrite.
2. Build on accessible headless primitives (Radix UI / React Aria) for behavior — focus management, ARIA, keyboard — and own only the styling layer, shadcn/ui style (copy-in components you can edit, not a locked dependency).
3. Manage variants with a typed API via `cva` (class-variance-authority): explicit `variant` and `size` props, a single source of truth for every visual state, sane defaults.
4. Make composition the contract: forward refs, spread `...props`, expose `asChild` (Radix Slot) so a `Button` can render as a link, and prefer slots over a sea of boolean props.
5. Define every interactive state in the recipe — hover, active, `focus-visible` ring, `disabled`, loading, invalid — and wire motion to your shared duration/easing tokens.
6. Document with live examples (Storybook or an MDX kitchen-sink page) and lock visual regressions; every component ships with usage + a11y notes.

## Rules
- Components are unopinionated about layout — no fixed margins; spacing belongs to the parent. They size to context.
- Accessibility is non-negotiable: keyboard-operable, correct roles/labels, `focus-visible` rings, contrast ≥4.5:1 for text.
- One token system; a hard-coded hex or pixel value inside a component is a leak to fix, not ship.
- Prefer composition over configuration — when prop count explodes, split the component or expose subcomponents (`Card.Header`).
- Keep the bundle lean: tree-shakeable exports, no kitchen-sink barrel that drags in everything.
