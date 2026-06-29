---
name: cdn-setup
description: Configure a CDN and cache layer in front of an origin for speed and offload
category: cloud
---

# CDN Setup

Reach for this to put a CDN (CloudFront, Cloudflare, Fastly) in front of an origin so static assets are served from the edge and the origin sees far less traffic.

1. Define the origin (host, port, protocol) and create the distribution/zone pointing at it.
2. Set cache behaviors: long TTLs for immutable static assets, short or bypass for HTML and authenticated routes.
3. Honor or override caching with `Cache-Control`/`Surrogate-Control` headers from the origin; decide which query strings, headers, and cookies are part of the cache key.
4. Attach TLS at the edge and force HTTPS; configure the custom domain (CNAME) and its certificate.
5. Set a cache-busting strategy — hashed/fingerprinted asset filenames so new deploys invalidate naturally.
6. Test cache behavior by inspecting `X-Cache`/`CF-Cache-Status`/`Age` response headers, then load-test to confirm origin offload.

## Rules
- Never cache authenticated or personalized responses at a shared edge — vary on auth or set `Cache-Control: private`.
- Prefer fingerprinted filenames over manual cache invalidation; invalidations are slow, rate-limited, and sometimes billed.
- Keep the cache key minimal — every cookie/header/query param you include fragments and dilutes the cache.
- Set sensible `Cache-Control` at the origin so the CDN, browsers, and intermediaries all agree.
- Watch for cache stampedes on misses; enable origin shielding / request coalescing for hot objects.
