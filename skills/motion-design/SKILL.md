---
name: motion-design
description: Define a coherent motion system — duration tokens, easing curves, and clear rules for when to animate.
category: ui-design
---

# Motion Design

Reach for this before adding any animation to a product, so motion is a designed system with tokens rather than one-off magic numbers scattered across components.

1. Define a duration scale as CSS custom properties: `--dur-1: 100ms` (micro), `--dur-2: 200ms` (UI), `--dur-3: 320ms` (entrances), `--dur-4: 500ms` (large/page). Scale duration with travel distance and element size.
2. Define an easing token set: `--ease-out: cubic-bezier(0.2, 0, 0, 1)` for enters, `--ease-in: cubic-bezier(0.4, 0, 1, 1)` for exits, `--ease-spring` for emphasis. Default to ease-out — elements decelerate into place.
3. Assign each animation a role: arrival (fade+rise), exit (fade+fall), state change, or attention. Different roles get different curves/durations — don't reuse one transition everywhere.
4. Orchestrate groups with a stagger of 30–60ms per item so lists cascade; cap total sequence length near 500ms so it never feels slow.
5. Prefer transform-driven motion (translate/scale) and physics-based springs (Framer Motion `type: "spring"`, sensible stiffness/damping) over linear tweens for anything interactive.
6. Provide a global `prefers-reduced-motion` fallback that collapses movement to opacity-only, and document the tokens so the team reuses them.

## Rules
- Motion must communicate (where did this come from, what changed), never decorate for its own sake.
- Never use `ease-in-out` for entrances — it starts slow and feels sluggish; reserve it for looping/ambient motion.
- Exits are faster than entrances (~0.7×); users have already decided, so get out of the way.
- No transition longer than ~500ms on an interaction the user is waiting on.
- One token set, imported everywhere — a stray `transition: all 0.3s` is a bug, not a shortcut.
