---
name: sitemap
description: Generate a valid sitemap.xml and robots.txt so crawlers discover and correctly index every public URL.
category: html
---

# Sitemap

Use when launching or growing a site and you want search engines to find all pages and respect crawl rules.

1. Enumerate canonical, indexable URLs (skip noindex, redirects, auth-only, and duplicate query-string variants); use absolute https URLs.
2. Emit `sitemap.xml` with the `urlset` schema: one `<url>` per page with `<loc>` and accurate `<lastmod>` (ISO 8601); `changefreq`/`priority` are optional and largely ignored.
3. If over 50,000 URLs or 50MB uncompressed, split into multiple sitemaps and reference them from a `sitemapindex` file.
4. Write `robots.txt` at the site root: allow crawlers to public content, `Disallow` admin/private paths, and add a `Sitemap: https://.../sitemap.xml` line.
5. Automate generation in the build (crawl the route table or filesystem) so the sitemap never drifts from the real pages.
6. Validate the XML, then submit the sitemap in Google Search Console / Bing Webmaster Tools and confirm it's fetched without errors.

## Rules
- Only list canonical, 200-status, indexable URLs; broken or redirected entries hurt trust.
- `robots.txt` blocks crawling, not indexing — use `<meta robots noindex>` to keep a page out of results.
- Keep `lastmod` honest; faking recent dates can get the sitemap ignored.
- Both files live at the domain root (`/sitemap.xml`, `/robots.txt`) and must be publicly fetchable.
- Don't `Disallow` resources (CSS/JS) the page needs to render — Google penalizes blocked rendering.
