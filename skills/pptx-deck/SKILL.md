---
name: pptx-deck
description: Generate a .pptx slide deck — use the built-in generate_pptx tool (no dependencies), or python-pptx for advanced custom layouts.
category: pptx
---

# PPTX Deck

Reach for this when the user wants a real, editable PowerPoint file (not HTML or PDF) built from a content outline or data.

**Default path — the built-in `generate_pptx` tool.** It renders a deck from structured JSON with zero external dependencies (no Python, no npm):

1. Confirm the deck's purpose, audience, and approximate slide count; sketch the slide order first (see slide-outline).
2. Write the actual content — slide titles, tight bullets, speaker notes. The tool renders; you write the copy.
3. Call `generate_pptx` with `path` and `slides`: `{title, subtitle}` for the opening slide, `{title, bullets: ["…", {"text": "…", "level": 1}], notes: "…"}` for content slides, `image` (local png/jpg/gif path) to embed a picture beside or under the text.
4. 16:9 output, consistent typography and colors are handled for you.

**Advanced path — python-pptx** (only when the user needs custom layouts, tables, charts on-slide, or must inherit a corporate template's theme):

1. `pip install python-pptx`; open a template `.pptx` with `Presentation(path)` to inherit its theme, or start blank.
2. Pick layouts from `prs.slide_layouts`; add slides with `prs.slides.add_slide(layout)`; fill placeholders or `add_textbox(...)` with `Inches(...)` from `pptx.util`.
3. Add images via `slide.shapes.add_picture`; route charts/tables through the slide-charts skill.
4. Style runs via `run.font` (`size=Pt(...)`, `color.rgb=RGBColor(...)`); save with `prs.save("deck.pptx")` and verify it opens.

## Rules
- One idea per slide; keep body text to 3-6 short bullets, never paragraphs.
- Prefer `generate_pptx` — it always works; reach for python-pptx only when its extra control is actually needed.
- Default 16:9 unless told otherwise (python-pptx: `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`).
- Don't fabricate logos, photos, or data; skip the `image` field (or leave a labeled placeholder) when an asset is missing.
