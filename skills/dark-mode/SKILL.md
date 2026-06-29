---
name: dark-mode
description: Implement a polished dark mode via semantic tokens and prefers-color-scheme, not naive color inversion
category: ui-design
---

# Dark Mode

Use this to add a dark theme that looks designed rather than inverted. Good dark mode is a parallel palette tuned for a dark substrate — it's not `filter: invert()`.

1. Theme through semantic tokens only: components read `--bg`, `--surface`, `--text`, `--border`, `--accent`. Dark mode redefines those aliases; component CSS doesn't change.
2. Avoid pure black (`#000`) backgrounds — use a very dark neutral (~oklch 0.18–0.22) so OLED smearing and harsh contrast soften, and so elevation can read.
3. Signal elevation with lighter surfaces, not shadows: raised cards get a slightly lighter `--surface-raised`. Shadows mostly disappear on dark; lightness becomes the depth cue.
4. Soften text: don't use `#fff` for body — drop to ~85–90% lightness to reduce halation, and re-check that muted text still clears 4.5:1 against the dark surface.
5. Reduce accent chroma slightly and verify it on dark — saturated hues that pop on white can vibrate on dark; tune `--accent` and `--accent-fg` per theme.
6. Wire it up: default to `@media (prefers-color-scheme: dark)`, allow a manual override via `[data-theme="dark"]` on `<html>`, persist the choice, and set `<meta name="color-scheme">` to avoid a white flash.
7. Dim large imagery/illustration in dark (e.g. slightly lower brightness) and provide dark-tuned shadows/borders so nothing glows.

## Rules
- Re-check contrast in dark independently — passing in light guarantees nothing.
- No pure `#000` background and no pure `#fff` text; both fatigue the eye.
- Convey depth with surface lightness, not drop shadows, in dark.
- Respect system preference by default, but let users override and persist it.
- Theme via token redefinition; never fork component styles per mode.
