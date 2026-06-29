---
name: color-palette
description: Craft an accessible on-brand palette with checked contrast, perceptual ramps, and semantic color roles
category: ui-design
---

# Color Palette

Use this when choosing or fixing a product's colors — to get past "pick a brand hue and tint it" into a palette that's coherent, accessible, and works in both light and dark.

1. Start from one or two brand hues and build perceptually even ramps in `oklch()` (11 steps, 50–950). Even lightness steps mean predictable contrast — RGB tinting gives muddy, uneven ramps.
2. Reserve saturation for intent: keep most surfaces near-neutral (low-chroma grays carrying a hint of the brand hue) and spend vivid color only on the accent and on calls to action.
3. Define semantic roles, not raw swatches: `--bg`, `--surface`, `--surface-raised`, `--text`, `--text-muted`, `--border`, `--accent`, `--accent-fg`, plus state colors success/warning/danger/info.
4. Check contrast for real: body text ≥ 4.5:1, large text and UI components ≥ 3:1 (WCAG AA). Pair every background token with a foreground that passes against it.
5. Design the dark variant as a sibling, not an inversion — raise surface lightness for elevation instead of adding shadows, and slightly lower accent chroma so it doesn't vibrate on dark.
6. Don't rely on hue alone to convey meaning; back status colors with an icon or label for color-blind users, and test with a deuteranopia simulation.
7. Constrain the whole palette: ~2 brand hues + neutrals + 4 state colors. A palette with 9 unrelated hues never feels designed.

## Rules
- Every text/background pairing passes WCAG AA (4.5:1 body, 3:1 large/UI) — verify, don't eyeball.
- Build ramps in oklch/HSL for even steps; avoid hand-picked hex stops.
- Most of the screen is neutral; saturated color is an accent, not a background.
- Name by role (`--accent`, `--danger`) so themes remap meaning, not pixels.
- Never encode state in color alone — add an icon, label, or shape.
