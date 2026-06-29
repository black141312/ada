---
name: design-tokens
description: Define color, space, type, radius, and shadow tokens as layered CSS custom properties with semantic roles
category: ui-design
---

# Design Tokens

Use this to turn scattered hardcoded values into a small, principled set of variables that every component reads from — the foundation under any design system or theme.

1. Split into two tiers: a primitive scale (`--gray-50`…`--gray-950`, `--blue-500`) that names raw values, and a semantic layer (`--bg`, `--surface`, `--text`, `--border`, `--accent`) that maps roles onto primitives.
2. Build space on a 4px base as a scale, not ad-hoc: `--space-1: 4px` … `--space-8: 32px`. Components only ever use scale steps, killing 13px and 27px outliers.
3. Define type tokens from a ratio (see typography): `--text-sm/base/lg/xl/2xl` plus `--leading-tight/normal/relaxed` and `--tracking-tight`. Pair each size with a sensible line-height.
4. Standardize radius (`--radius-sm/md/lg/full`) and elevation (`--shadow-sm/md/lg`) as layered, low-alpha shadows — never a single harsh `0 2px 4px #000`.
5. Express color in `oklch()` for perceptually even ramps and easy lightness flips; provide `--color-*` semantic aliases so dark mode redefines the alias, not the component.
6. Scope tokens to `:root`, override per-theme via `[data-theme]` or `@media (prefers-color-scheme)`, and expose only semantic tokens to component code.
7. Generate platform outputs (CSS vars, Tailwind config, JSON) from one source file (e.g. Style Dictionary) so web and native never diverge.

## Rules
- Components consume semantic tokens only; primitives are private implementation detail.
- No naked values in component CSS — every color, space, radius, and shadow is a `var(--…)`.
- Name tokens by purpose (`--text-muted`) not appearance (`--gray-400`).
- Keep each scale short (5–9 steps); an infinite ramp invites inconsistency.
- Use `oklch()`/`hsl()` over hex so you can derive hover/active states by nudging lightness.
