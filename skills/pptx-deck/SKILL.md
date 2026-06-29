---
name: pptx-deck
description: Generate a .pptx slide deck programmatically with python-pptx from a content outline.
category: pptx
---

# PPTX Deck

Reach for this when the user wants a real, editable PowerPoint file (not HTML or PDF) built from a content outline or data.

1. Confirm the deck's purpose, audience, and approximate slide count; sketch the slide order first (see slide-outline) before writing code.
2. `pip install python-pptx`; start a `Presentation()` (or open a template `.pptx` to inherit its theme).
3. Pick layouts from `prs.slide_layouts` (0=title, 1=title+content, 5=title-only, 6=blank); add slides with `prs.slides.add_slide(layout)`.
4. Fill `slide.shapes.title` and body placeholders; for free placement use `add_textbox(left, top, width, height)` with `Inches(...)` from `pptx.util`.
5. Add images via `slide.shapes.add_picture`, and route charts/tables through the slide-charts skill rather than hand-rolling them.
6. Set consistent fonts/sizes/colors on `run.font` (`size=Pt(...)`, `color.rgb=RGBColor(...)`); save with `prs.save("deck.pptx")` and verify it opens.

## Rules
- One idea per slide; keep body text to 3-6 short bullets, never paragraphs.
- Use `Inches()`/`Pt()`/`Emu()` from `pptx.util` — never raw integers for positions or sizes.
- Reuse a single helper for adding slides so spacing, fonts, and margins stay uniform.
- Default 16:9 (`prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`) unless told otherwise.
- Don't fabricate logos, photos, or data; leave a labeled placeholder shape when an asset is missing.
