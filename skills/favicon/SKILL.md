---
name: favicon
description: Generate a full favicon and app-icon set (SVG, PNG, Apple touch, manifest) with the correct head markup.
category: html
---

# Favicon

Use when a site needs proper tab icons, iOS home-screen icons, and PWA install icons across browsers and platforms.

1. Start from a square master (SVG or 512x512+ PNG) with a simple, high-contrast mark that stays legible at 16x16.
2. Generate the set: `favicon.svg` (scalable, preferred), `favicon.ico` (multi-size 16/32/48 for legacy), `apple-touch-icon.png` (180x180), and 192/512 PNGs for the manifest.
3. Provide a maskable icon variant (safe-zone padded) so Android adaptive icons don't crop the mark; mark it `purpose: "maskable"` in the manifest.
4. Add a `site.webmanifest` listing icons, `name`, `short_name`, `theme_color`, and `background_color` for PWA installs.
5. Wire the `<head>`: `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`, `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`, `<link rel="manifest" href="/site.webmanifest">`.
6. Add a `<link rel="icon">` dark variant via media query if the mark needs it, then verify in a real browser tab, an iOS Add-to-Home-Screen, and an Android install prompt.

## Rules
- Provide an SVG favicon plus a fallback `.ico`; don't rely on the legacy root `/favicon.ico` auto-discovery alone.
- Apple touch icons need an opaque background and no transparency — iOS adds its own rounded corners.
- Maskable icons must keep the logo inside the ~80% safe zone or Android will crop it.
- Use absolute or root-relative icon paths so they resolve on every route.
- Bust the cache (filename hash or query) when updating an icon; browsers cache favicons aggressively.
