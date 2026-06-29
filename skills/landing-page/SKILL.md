---
name: landing-page
description: Build a responsive marketing landing page with a hero, value sections, social proof, and a clear conversion CTA.
category: html
---

# Landing Page

Use when building a single-purpose conversion page (product launch, signup, waitlist). The job is one clear action above the fold and a scannable narrative below it.

1. Lay out the standard arc: hero (headline + subhead + primary CTA), problem/benefit sections, social proof, feature grid, FAQ, final CTA, footer.
2. Write the hero with a benefit-driven headline (not the product name), a one-line subhead, and a single high-contrast CTA button; keep it readable on mobile without scrolling.
3. Build the layout mobile-first with semantic landmarks (`<header> <main> <section> <footer>`) and CSS grid/flex; use `clamp()` for fluid type and spacing.
4. Add a sticky or repeated CTA so the action is always reachable; make every CTA button visually identical and lead to the same target.
5. Optimize for speed: inline critical CSS, lazy-load below-fold images (`loading="lazy"`), use responsive `<img srcset>` / modern formats (AVIF/WebP), defer non-critical JS.
6. Layer in trust: real logos, testimonials with names/photos, concrete numbers; add SEO + OpenGraph meta tags (see `meta-tags` skill).
7. Verify contrast (WCAG AA), keyboard focus states, and that the page works with JS disabled.

## Rules
- One primary conversion goal per page; secondary links should not compete with the main CTA.
- Mobile-first: design the small viewport first, then enhance up with `min-width` media queries.
- Don't ship a megabyte hero image — compress, size to display dimensions, and serve modern formats.
- Use semantic headings in order (one `<h1>`, then `<h2>`/`<h3>`); don't pick heading levels by size.
- Avoid render-blocking third-party widgets above the fold; they tank Largest Contentful Paint.
