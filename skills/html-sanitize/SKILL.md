---
name: html-sanitize
description: Sanitize untrusted/user-supplied HTML to be XSS-safe using an allowlist library, never hand-rolled regex.
category: html
---

# HTML Sanitize

Use whenever you render HTML you didn't author — comments, rich-text input, CMS content, AI output — into a page. Naive insertion is a stored-XSS hole.

1. Pick a battle-tested allowlist sanitizer: DOMPurify (browser/Node), sanitize-html (Node), Bleach (Python), or the language's equivalent; never write your own escaper.
2. Configure a strict allowlist of tags and attributes (e.g., `p, a, strong, em, ul, li, code` + `href`, `title`); deny everything else by default.
3. Strip dangerous vectors: `<script>`, `<style>`, `<iframe>`, event handlers (`on*`), and `javascript:`/`data:` URLs in `href`/`src`.
4. Force-harden links: set `rel="noopener noreferrer"` and validate the URL scheme against an allowlist (`https`, `mailto`).
5. Sanitize server-side as the source of truth (don't trust client-side sanitization alone) and re-sanitize on render, not just on input.
6. Add a Content-Security-Policy header as defense-in-depth, and test with known XSS payloads (`<img src=x onerror=alert(1)>`, SVG/MathML vectors, mutation-XSS cases).

## Rules
- Never sanitize HTML with regex or string replacement — parsers and mXSS will defeat it.
- Allowlist what's permitted; never blocklist "bad" tags (the bad list is infinite).
- Keep the sanitizer library updated; bypasses are found and patched regularly.
- For plain text, escape (`&lt; &gt; &amp;`) instead of sanitizing — don't allow any HTML at all.
- CSP is a backstop, not a substitute for sanitizing the input.
