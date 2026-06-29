---
name: pptx-from-markdown
description: Convert a markdown document into slides using Marp or reveal.js, exporting to PPTX or HTML.
category: pptx
---

# PPTX From Markdown

Use when the source is markdown (or the user prefers writing slides as text) and wants fast, version-controllable slides. Marp is the quickest path to a `.pptx`; reveal.js gives richer interactive HTML.

1. Choose the tool: Marp (`@marp-team/marp-cli`) for clean PPTX/PDF export, reveal.js for animated browser decks.
2. Write the markdown: separate slides with `---`, use `#`/`##` for titles and `-` bullets; one idea per slide.
3. Add a Marp front-matter block (`marp: true`, `theme:`, `paginate: true`) or a reveal.js config to set the look.
4. Use per-slide directives for layout (`<!-- _class: lead -->`, background images via `![bg](img.png)`) where needed.
5. Render: `marp deck.md -o deck.pptx` (or `--pdf`/`--html`), or serve reveal.js and export via its print/PDF route.
6. Open the output and verify slide breaks, images, and code blocks survived the conversion.

## Rules
- Exactly one `---` between slides; a stray rule splits or merges slides unexpectedly.
- Keep heading levels consistent — Marp maps them to title vs. body styling.
- Reference images by relative path and keep them beside the markdown so export resolves them.
- Marp PPTX export rasterizes some styling; if the user needs fully editable native shapes, use pptx-deck instead.
- Set the theme once in front-matter rather than styling slides individually.
