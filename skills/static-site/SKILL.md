---
name: static-site
description: Scaffold a fast, framework-free static site with shared partials, clean URLs, and a simple build step.
category: html
---

# Static Site

Reach for this when a site is mostly content (docs, blog, brochure) and a framework would be overkill. Plain HTML/CSS/JS deploys anywhere and stays fast for years.

1. Lay out the tree: `index.html`, `/assets` (css, js, img), `/pages` for additional routes, and a `404.html`; keep one shared stylesheet.
2. Factor repeated chrome (head, header, footer) into partials; assemble with a tiny tool (`eleventy`, `npx serve` + includes, or a 20-line build script) rather than copy-pasting.
3. Write semantic, accessible markup with shared meta defaults; set `<html lang>`, viewport, and a single design-token CSS file using custom properties.
4. Use clean URLs via directory `index.html` files (`/about/index.html` -> `/about/`); keep relative links portable.
5. Optimize assets: minify CSS/JS, compress and size images, add `loading="lazy"`, and set long cache headers for hashed assets.
6. Add a local dev loop (`python -m http.server` or `npx serve`) and a one-command build; output to a `dist/` folder for deploy.
7. Generate `sitemap.xml` + `robots.txt` (see `sitemap` skill) and deploy to any static host (Netlify, Pages, S3, Cloudflare).

## Rules
- No framework unless a real need appears; ship HTML/CSS and progressively enhance with vanilla JS.
- Keep the build reproducible and dependency-light; a script you can read beats a config you can't.
- Use relative or root-absolute links consistently so the site works under any subpath.
- Don't inline large data or base64 images into HTML; reference real asset files for caching.
- Always include `<meta name="viewport">` and a `lang` attribute; test with JS disabled.
