---
name: meta-tags
description: Add SEO, OpenGraph, and Twitter Card meta tags plus canonical and structured data for rich link previews.
category: html
---

# Meta Tags

Use when a page needs to rank and to unfurl well when shared on social/chat. Covers the core `<head>` tags search engines and link-preview crawlers read.

1. Set the basics: unique `<title>` (~50-60 chars), `<meta name="description">` (~150-160 chars), `<meta charset="utf-8">`, and `<meta name="viewport">`.
2. Add `<link rel="canonical" href="https://...">` (absolute URL) to prevent duplicate-content splits across query strings and trailing slashes.
3. Add OpenGraph: `og:title`, `og:description`, `og:type`, `og:url`, `og:image` (absolute URL, 1200x630), and `og:site_name`.
4. Add Twitter Card: `twitter:card` = `summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`.
5. Add JSON-LD structured data (`<script type="application/ld+json">`) for the page type (Article, Product, Organization, BreadcrumbList) to enable rich results.
6. Set `<meta name="robots">` intentionally (`index,follow` or `noindex`) and verify with a link-preview debugger (Facebook Sharing Debugger, Twitter Card Validator) and Google Rich Results test.

## Rules
- Every URL in meta tags (canonical, og:image, og:url) must be absolute with scheme; relative URLs break crawlers.
- `og:image` must be a real, publicly reachable file at 1200x630 (~under 5MB); social crawlers don't run JS.
- One canonical per page; don't point canonical at a redirect or a noindexed URL.
- Keep title/description unique per page — don't template the same description sitewide.
- Validate JSON-LD; a syntax error silently disables the rich result.
