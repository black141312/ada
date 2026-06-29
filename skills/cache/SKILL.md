---
name: cache
description: Add caching (memoize/LRU/HTTP) where it pays off, with correct keys and invalidation
category: performance
---

# Cache

Reach for this when the same expensive computation or fetch repeats with identical inputs and recomputing is the bottleneck.

1. Confirm the work is cacheable: deterministic for a given key, read-heavy, and expensive enough that caching beats the lookup overhead.
2. Define the cache key precisely — include every input that changes the result; exclude volatile or irrelevant fields.
3. Pick the layer: memoize a pure function, an in-process LRU with a size cap, a shared store (Redis), or HTTP `Cache-Control`/`ETag` for responses.
4. Set bounds: max entries or memory cap plus a TTL, so the cache can't grow unbounded or serve stale data forever.
5. Define invalidation up front — TTL expiry, write-through on update, or explicit bust on the events that change the source.
6. Measure hit rate and latency before/after; if the hit rate is low or correctness gets fragile, remove it.

## Rules
- An unbounded cache is a memory leak — always cap size and/or TTL.
- A wrong key is worse than no cache: too broad serves stale results, too narrow never hits.
- Don't cache cheap, fast, or rarely-repeated work — the bookkeeping costs more than it saves.
- Cache invalidation is the hard part; prefer TTL or write-through over hand-rolled bust logic.
- Never cache per-user or sensitive data in a shared/global cache without scoping the key to the user.
