---
name: micro-interactions
description: Add tasteful hover/press/focus micro-interactions and feedback that feel responsive without distracting.
category: ui-design
---

# Micro-Interactions

Reach for this when a UI feels static or unresponsive — buttons, toggles, cards, and inputs should acknowledge every interaction within ~100ms.

1. Map the three states for each interactive element: rest, hover, active/press, plus a `:focus-visible` ring for keyboard users — never style all four identically.
2. Set durations by intent: 80–120ms for press/feedback, 150–200ms for hover, and pair with `transition-timing-function: cubic-bezier(0.2, 0, 0, 1)` (ease-out) so motion settles fast.
3. On press, apply a subtle `transform: scale(0.97)` or 1px translate — physical, not bouncy. Reserve a gentle overshoot spring only for playful toggles/likes.
4. Telegraph intent with secondary cues: shift `background`, lift with `box-shadow`, or nudge an icon — change 2 properties max so it reads as one motion.
5. Confirm async actions inline: swap label → spinner → checkmark, then settle. Use optimistic UI where the success rate is high.
6. Respect `@media (prefers-reduced-motion: reduce)` — drop transforms, keep instant color/opacity feedback so the cue survives.

## Rules
- Hover effects are progressive enhancement; the element must be fully usable and legible without them (touch + keyboard).
- Animate `transform` and `opacity` only on the hot path — never `width`, `top`, or `box-shadow` in tight loops (they trigger layout/paint).
- Keep focus rings visible and ≥3:1 contrast against the adjacent surface; never `outline: none` without a replacement.
- One signature interaction per surface — if everything wiggles, nothing reads as special.
- Feedback latency budget is 100ms; beyond that, show a loading state instead of a delayed jump.
