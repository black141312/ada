---
name: html-email
description: Build a responsive HTML email with inline CSS, table layout, and dark-mode support that survives Outlook/Gmail.
category: html
---

# HTML Email

Reach for this when you need a marketing or transactional email that renders consistently across Gmail, Outlook, and Apple Mail. Email clients strip `<style>`, ignore flexbox/grid, and demand tables.

1. Set up the skeleton: `<table role="presentation" width="100%">` outer wrapper centering a `<table width="600">` content table; never use `<div>` for layout.
2. Add `<!--[if mso]>` conditional comments for Outlook (it uses Word's rendering engine) and a VML fallback for any background image or button.
3. Write all visual CSS inline on elements (`style="..."`); keep a `<style>` block in `<head>` only for media queries and `:root` color-scheme hints.
4. Make it fluid: content table `width="600"` with `max-width:600px`, single-column stacking via `@media (max-width:600px){ .col{display:block;width:100%!important} }`.
5. Add dark mode: `<meta name="color-scheme" content="light dark">`, `@media (prefers-color-scheme:dark)` overrides, and dark-friendly logo (transparent PNG).
6. Use bulletproof buttons (table-cell with padding + bgcolor, not a styled `<a>`), set `alt` on every image, and keep total HTML under ~100KB (Gmail clips beyond 102KB).
7. Test in Litmus/Email-on-Acid or send to real Gmail + Outlook + iOS before shipping.

## Rules
- Tables for layout, inline CSS for styling — no flexbox, grid, float, or external stylesheets.
- Always provide `alt` text and explicit `width`/`height`; many clients block images by default.
- Use web-safe fonts with a stack fallback; custom `@font-face` fails in Outlook and most clients.
- Use absolute https URLs for every image and link; no relative paths.
- Include a plain-text preheader (hidden span) and a working unsubscribe link for deliverability.
