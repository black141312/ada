---
name: mkdocs-setup
description: Stand up a docs site (MkDocs or Docusaurus) with navigation, search, and a working local preview.
category: docs
---

# MkDocs Setup

Reach for this when a project needs a real documentation site, not just a README — versioned pages, a nav tree, and full-text search.

1. Pick the stack: MkDocs + Material for Python/simple sites; Docusaurus for React/versioned/i18n-heavy docs. Default to MkDocs Material.
2. Scaffold: `pip install mkdocs-material` then `mkdocs new .` (or `npx create-docusaurus@latest docs classic`).
3. Create `docs/index.md` plus a page per top-level topic; keep one `<h1>` per file and use relative links between pages.
4. Define the nav explicitly in `mkdocs.yml` (`nav:`) so order is deterministic; don't rely on filesystem ordering.
5. Enable search and theme features in config (`theme: name: material`, `plugins: [search]`, `features: [navigation.sections, search.suggest]`).
6. Preview with `mkdocs serve` (or `npm start`) and watch for broken-link / missing-nav warnings in the console.
7. Build static output with `mkdocs build --strict` and deploy via CI (GitHub Pages: `mkdocs gh-deploy`).

## Rules
- `--strict` in CI so broken links and orphaned pages fail the build instead of shipping.
- Keep `docs/` flat-ish; deep folder nesting makes relative links fragile and nav noisy.
- Pin the docs toolchain version (requirements.txt / package.json) so builds are reproducible.
- Don't hand-edit generated `site/`; it's output — commit only sources.
- Add a `site_url` so search, canonical links, and sitemap generation work correctly.
