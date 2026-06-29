---
name: ui-polish
description: Elevate a rough but working UI — fix spacing, alignment, hierarchy, and the small details that read as quality
category: ui-design
---

# UI Polish

Reach for this on a UI that functions but feels amateur — cramped, misaligned, flat. Polish is mostly subtraction and precision, not adding more.

1. Establish a spacing rhythm: snap every margin/padding/gap to the 4px (or 8px) scale, and make whitespace intentional — generous around groups, tight within them. Inconsistent gaps are the #1 tell.
2. Fix alignment to an actual grid: align edges and baselines, give content a `max-width` and consistent gutters, and make optical adjustments (icons often need a nudge to look centered).
3. Sharpen hierarchy: there should be an obvious first, second, and third thing on every screen. Use size, weight, and `--text-muted` color to demote secondary text instead of cramming everything at one level.
4. Tame the details: soften pure-black text to a near-black, swap harsh `0 1px 2px #000` shadows for layered low-alpha ones, align radii across siblings, and ensure border colors are subtle (low-contrast neutrals).
5. Polish interaction: add `:focus-visible` rings, hover/active feedback, and tasteful transitions (120–200ms, `ease-out`) on color and transform — never on `width`/`height` (use `transform`).
6. Handle the real states: empty, loading (skeletons over spinners), error, and long-content overflow. Unpolished UIs only ever show the happy path.
7. Do a final squint test and a 50%-zoom pass — blurred vision exposes weak hierarchy and ragged alignment instantly.

## Rules
- Every spacing value is on the scale; an unexplained `padding: 13px` is a defect.
- Increase contrast in hierarchy, decrease it in chrome — borders and shadows should whisper.
- Animate `transform`/`opacity` only; transitions 120–250ms with `ease-out`/custom cubic-bezier.
- Never ship without focus-visible, hover, empty, and loading states.
- When in doubt, remove an element or add whitespace before adding decoration.
