---
name: design-system
description: Build a cohesive design system from tokens up to components, with one source of truth and zero magic numbers
category: ui-design
---

# Design System

Reach for this when a UI has grown inconsistent — drifting spacings, one-off colors, copy-pasted buttons — or when starting a product that needs to scale past a few screens.

1. Audit what exists: screenshot every surface, list every distinct color, font size, radius, shadow, and spacing in use. The sprawl you find is the problem statement.
2. Define the token layer first (see the design-tokens skill): primitives (`--blue-500`), then semantic aliases (`--color-accent`, `--bg-surface`, `--text-muted`). Components reference semantics only, never primitives.
3. Lock the foundations: a modular type scale (1.2–1.25 ratio), a 4px spacing base, a radius set (sm/md/lg/full), and 2–3 elevation shadows. Everything downstream composes from these.
4. Build primitives as composable components: Button (variant × size × state), Input, Card, Badge. Encode every visual decision as a token, so a theme swap is a token swap.
5. Codify states explicitly — default, hover, focus-visible, active, disabled, loading. A system that only specifies the resting state isn't a system.
6. Document usage with live examples and do/don't pairs (Storybook or an MDX page). A token nobody knows about gets bypassed.
7. Ship with lint guardrails: reject raw hex and arbitrary px in PRs so drift can't creep back in.

## Rules
- One source of truth: a value lives in exactly one token; if you typed a hex or px in a component, it's a bug.
- Two-tier tokens always — primitive then semantic — so re-theming touches the alias layer only.
- Name by role, not by look: `--color-danger`, not `--color-red` (red may become orange later).
- Every interactive component must define focus-visible and disabled, not just hover.
- Prefer composition over variant explosion; if a component has 12 boolean props, split it.
