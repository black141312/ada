---
name: responsive
description: Make a layout adapt cleanly across mobile, tablet, and desktop breakpoints
category: frontend
---

# Responsive

Use when a layout breaks, overflows, or looks cramped at some viewport sizes and needs to flex across breakpoints.

1. Identify the breakpoints from the existing system (Tailwind/CSS vars/theme) rather than inventing new ones, and design mobile-first — base styles target the smallest screen.
2. Reach for intrinsic layout first: flexbox, CSS grid, `gap`, `minmax`, `clamp()`, and `%`/`fr` units before adding media queries.
3. Layer `min-width` media queries (or container queries when the component must adapt to its parent, not the viewport) to progressively enhance toward larger screens.
4. Make media fluid: `max-width: 100%` on images, responsive `srcset`/`sizes`, and `aspect-ratio` to prevent layout shift.
5. Handle text and spacing: fluid type via `clamp()`, wrap/scroll long content, and ensure tap targets are at least ~44px on touch.
6. Test at real breakpoints and in between (narrow, tablet, wide, and the awkward sizes), checking for overflow, clipped content, and horizontal scroll.

## Rules
- Write mobile-first: unconditional base styles, then `min-width` queries that add, not undo.
- Avoid fixed pixel widths/heights on containers; let content and the grid dictate size.
- Never cause horizontal scroll — watch for fixed widths, large images, and `100vw` + padding.
- Use container queries when a reusable component lives in varying-width slots.
- Don't hide content on small screens to "fix" layout unless it's genuinely redundant.
