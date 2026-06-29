---
name: rate-limit
description: Add rate limiting to an API with correct keys, headers, and 429 responses
category: api
---

# Rate Limit

Use when an endpoint or whole API needs throttling to protect against abuse, runaway clients, or cost blowups.

1. Decide the limit key — per API key, per user, or per IP — and pick the scope (global vs per-route); document the chosen limit and window.
2. Choose an algorithm (token bucket or sliding window) and a store: in-memory only for single-instance, Redis/shared store for multi-instance.
3. Add the limiter as middleware or a decorator at the boundary, before expensive work runs.
4. On rejection return `429 Too Many Requests` with a `Retry-After` header and a clear error body.
5. Emit `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers on responses so clients can self-throttle.
6. Test the boundary: requests under the limit pass, the request over it returns 429, and the counter resets after the window.

## Rules
- Use a shared store (Redis) when more than one instance serves traffic — in-memory counters under-count behind a load balancer.
- Rate-limit on a trustworthy key; raw client IP is spoofable and breaks behind proxies unless you read the right forwarded header.
- Fail open or closed deliberately — if the limiter store is down, decide whether to allow or block, don't crash the request.
- Always include `Retry-After` so well-behaved clients back off instead of hammering.
- Keep the limiter cheap; a slow check on every request defeats the purpose.
