---
name: pptx-export
description: Export a .pptx deck to PDF or per-slide images for sharing, printing, or web embedding.
category: pptx
---

# PPTX Export

Use when a finished deck needs a non-editable, portable format — a PDF handout, or PNG/JPG images of each slide for the web or docs.

1. Confirm the target: PDF (handout/print) or per-slide images (web, thumbnails, social), and the resolution needed.
2. Prefer LibreOffice headless for fidelity: `soffice --headless --convert-to pdf deck.pptx` (works cross-platform, no PowerPoint).
3. For images, convert to PDF first, then rasterize pages with `pdftoppm -png deck.pdf slide` or ImageMagick/`pdf2image`.
4. On Windows with PowerPoint installed, COM automation (`win32com.client`) can export PDF and PNG natively with best font fidelity.
5. For multi-up handouts, use the PDF export's notes/handout layout or print N-slides-per-page.
6. Open the output and spot-check fonts, chart rendering, and image quality before delivering.

## Rules
- LibreOffice is the most portable converter; results can differ slightly from PowerPoint on fonts and effects — verify visually.
- Ensure fonts used in the deck are installed on the converting machine, or text reflows and substitutes.
- Choose DPI by use: ~96-150 for screen, 300 for print.
- Embed fonts in the source deck where possible so exports stay faithful.
- Keep the original `.pptx` as the source of truth; treat PDF/images as disposable artifacts.
