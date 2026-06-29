---
name: pptx-template
description: Apply a branded template/theme (fonts, colors, logo, master slides) to a PowerPoint deck.
category: pptx
---

# PPTX Template

Use when a deck needs to match brand guidelines, or when a client supplies a `.potx`/`.pptx` template the content must adopt.

1. Obtain the brand inputs: a template file (`.potx`/`.pptx`), or the palette (hex codes), fonts, and logo to build one.
2. When a template exists, open it directly with `Presentation("template.pptx")` so new slides inherit its layouts and theme.
3. Map your content slides to the template's `slide_layouts` by index/name — use the layouts it defines, not generic blank slides.
4. With no template, define a small theme dict (primary/secondary/accent colors, title/body fonts, sizes) and apply it through one styling helper.
5. Place the logo and any footer/page-number consistently via the slide master or a repeated helper, not per-slide by hand.
6. Render a few representative slides and check contrast, font fallback, and logo placement before applying to the full deck.

## Rules
- Prefer inheriting an existing template file over reconstructing a theme by hand.
- Centralize colors and fonts in one place so a rebrand is a single edit.
- Ensure text/background contrast meets readability (aim for WCAG AA on body text).
- Embed or confirm brand fonts are installed; otherwise pick a close, available fallback and note it.
- Keep the logo at consistent size/position and don't distort its aspect ratio.
- Don't let template decoration crowd content — whitespace is part of the brand.
