---
name: page-transitions
description: Add smooth route/page transitions with the View Transitions API or Framer that preserve context.
category: ui-design
---

# Page Transitions

Reach for this when route changes feel abrupt — a well-crafted transition maintains spatial continuity so users keep their place between views.

1. Pick the mechanism: native View Transitions API (`document.startViewTransition`, or `@view-transition { navigation: auto }` for MPAs) where supported; Framer Motion `AnimatePresence` with `mode="wait"` for React SPAs.
2. Default to a fast crossfade (~200–300ms) for unrelated routes; it's invisible-but-smooth and the safest baseline.
3. For shared elements (a card → its detail page), give both a matching `view-transition-name` (or Framer `layoutId`) so the element morphs in place — this is the high-value move.
4. Tune the generated pseudo-elements: style `::view-transition-old(root)` / `::view-transition-new(root)` with your easing tokens; clip-path or slide for directional hierarchy (forward = in from right, back = out to right).
5. Avoid layout shift mid-transition: hold scroll position or restore it explicitly, and ensure the incoming page's above-fold content is ready (Suspense/loaded data) before revealing.
6. Always ship a no-transition fallback for unsupported browsers (feature-detect `startViewTransition`) and honor `prefers-reduced-motion` with an instant swap.

## Rules
- A transition must orient the user, not entertain — if it makes navigation feel slower, shorten or cut it.
- Keep durations ≤300ms; users navigate constantly and a flashy 600ms transition becomes friction by the tenth click.
- Shared-element transitions need stable, unique names — duplicated `view-transition-name` on one page throws and breaks the animation.
- Never animate during the transition something that also triggers data fetching — wait for the new view's critical content first.
- Test back/forward and rapid navigation; transitions must be interruptible and not queue/stack.
