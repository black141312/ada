---
name: font-rendering
description: Debug text rendering — missing glyphs/tofu, wrong fallback font, bad kerning, blurry or clipped subpixel text
category: graphics
---

# Font Rendering

Reach for this when text shows boxes/question marks, jumps to the wrong typeface, looks blurry, or clips at the edges.

1. Identify the failure mode first: "tofu" boxes (□) mean the glyph is missing from the loaded font; a different-looking-but-readable face means fallback kicked in; blur/clipping is a rasterization or metrics issue.
2. For missing glyphs, confirm the font actually loaded and covers the codepoints: use `document.fonts.check('16px MyFont')` / `document.fonts.ready`, and verify the character's Unicode range is in the font (CJK, emoji, and rare symbols are often absent).
3. For wrong-font fallback, check the `@font-face` URL loads (network tab, no 404/CORS), `font-family` name matches exactly, and the `font-weight`/`font-style` you request exists — requesting bold from a regular-only file triggers synthetic or fallback rendering.
4. For FOUT/FOIT flashes, set `font-display` deliberately and preload the font; layout shift on swap is a metrics mismatch between fallback and real font — tune with `size-adjust`/`ascent-override` or a closer fallback.
5. For canvas text, remember the font must be loaded before `fillText`; call `await document.fonts.load('16px MyFont')` first or you'll silently rasterize in the fallback face.
6. For blur/clipping, check subpixel positioning and DPI scaling (see dpi-scaling), ensure the baseline/`textBaseline` and line-height give enough box, and that no `transform` is fractional-translating the text off the pixel grid.

## Rules
- Tofu = glyph absent from the font; pick a font with the needed Unicode coverage, don't fight the renderer.
- Always await font load before drawing canvas text — `fillText` won't wait and falls back silently.
- The CSS `font-family` name must match the `@font-face` `font-family` exactly, including case and spaces.
- Requesting a weight/style the file lacks yields synthetic faux-bold/italic or fallback — ship the real weights.
- Blurry text is usually DPI/subpixel, not the font; rule out devicePixelRatio before blaming the typeface.
