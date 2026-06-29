---
name: web-fonts
description: Load and pair web fonts performantly — subset, preload, self-host, and avoid FOUT/FOIT and layout shift
category: ui-design
---

# Web Fonts

Use this when adding or fixing custom fonts so they look right *and* load fast. Fonts are often a page's heaviest render-blocking asset and a top cause of layout shift.

1. Prefer variable fonts in `woff2` only — one file covers all weights, drops requests, and `woff2` is the smallest format every modern browser supports.
2. Self-host instead of linking Google Fonts: it removes a third-party round-trip and the privacy/consent overhead, and lets you control caching and `font-display`.
3. Subset aggressively — strip to the scripts/glyphs you use (e.g. latin + latin-ext) with `glyphhanger`/`fonttools`; a full font can shrink 70%+, cutting first paint.
4. `preload` the one or two critical fonts (the body and primary heading face) with `<link rel="preload" as="font" type="font/woff2" crossorigin>`; don't preload every weight.
5. Set `font-display: swap` to render text immediately in a fallback, then tune the fallback metrics with `size-adjust`, `ascent-override`, and `descent-override` (or Next/Fontsource defaults) so the swap causes near-zero CLS.
6. Define a real fallback stack matched in metrics to the web font (`"Inter", system-ui, sans-serif`) so the pre-swap render already looks close.
7. Measure: confirm in DevTools that fonts are `woff2`, preloaded, swapped, and that the layout-shift score stays near zero after they load.

## Rules
- `woff2` only, variable font when available; never serve `ttf`/`otf`/multiple static weights.
- Self-host critical fonts; reserve external CDNs for non-critical or fallback cases.
- Preload only the 1–2 above-the-fold faces — preloading everything defeats the purpose.
- `font-display: swap` plus metric-overridden fallbacks to keep CLS ≈ 0.
- Subset to the glyphs you actually render; ship no unused scripts.
