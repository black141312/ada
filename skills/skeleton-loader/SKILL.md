---
name: skeleton-loader
description: Build loading skeletons and shimmer that mirror the final layout to reduce perceived wait and CLS.
category: ui-design
---

# Skeleton Loader

Reach for this when content takes a beat to load and a spinner would feel slow or cause layout shift — skeletons preview structure so the page feels fast and stable.

1. Mirror the real layout: build the skeleton from the same component with placeholder blocks at the actual sizes/positions, so swapping in data causes zero shift (protects CLS).
2. Skeleton-ize structure, not pixels: a few grey rounded blocks for title/avatar/lines — vary line widths (last line ~60%) so it reads as text, not a wireframe of every glyph.
3. Animate with a restrained shimmer: a slow gradient sweep (~1.5–2s linear, looping) or a gentle opacity pulse — subtle, low-contrast, never a strobing distraction.
4. Use the skeleton only past a perception threshold: render instantly when content is likely <~200ms? show nothing or the cached value; show the skeleton when you expect a real wait, and avoid flash-of-skeleton for sub-100ms loads.
5. Transition out smoothly: crossfade skeleton → content (~150ms) rather than a hard pop, and stagger if many items resolve together.
6. Honor `prefers-reduced-motion` by replacing the sweep with a static muted block, and keep the skeleton color derived from your surface/muted tokens for theme + dark-mode correctness.

## Rules
- Skeleton dimensions must equal final dimensions — if the content reflows on load, the skeleton failed its one job.
- Keep shimmer low-contrast and slow; a fast, high-contrast sweep is more annoying than a spinner.
- Don't skeleton a whole page when only one region is async — load shell + chrome instantly, skeleton just the pending part.
- Avoid skeleton flicker: gate on a short delay so fast responses never flash a placeholder.
- Build from muted/surface tokens so it adapts to light/dark automatically — no hard-coded greys.
