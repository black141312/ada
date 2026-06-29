---
name: html-to-pdf
description: Render HTML to a print-quality PDF with correct page breaks, margins, headers/footers, and selectable text.
category: html
---

# HTML to PDF

Use when you need a paginated, print-fidelity PDF (invoice, report, certificate) from HTML/CSS rather than a screenshot.

1. Pick the engine: headless Chromium (Playwright/Puppeteer `page.pdf()`) for modern CSS, or WeasyPrint for pure-Python paged-media; both keep text selectable.
2. Author a print stylesheet with `@page { size: A4; margin: 18mm }` and `@media print` rules; set a base font size in `pt`/`mm`, not `px`.
3. Control pagination with `break-inside: avoid` on cards/tables, `break-before: page` for new sections, and `orphans`/`widows` for paragraphs.
4. Add running headers/footers and page numbers via `@page` margin boxes (`content: counter(page)`) or the engine's header/footer template option.
5. Ensure `printBackground: true` (Chromium) so background colors/images render; embed fonts so they aren't substituted.
6. Verify output: check pixel-perfect margins, that tables don't split mid-row awkwardly, links remain clickable, and text is selectable (not rasterized).

## Rules
- Use real paged-media CSS, not viewport hacks; set page size and margins in `@page`.
- Wait for fonts and images to fully load before generating (`waitUntil: networkidle`) or content clips.
- Prefer vector/text output over screenshots so the PDF stays small and searchable.
- Test the exact paper size you'll print (A4 vs Letter differ); don't assume the default.
- Avoid fixed-height containers for variable content — they overflow or clip across page breaks.
