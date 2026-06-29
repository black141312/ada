---
name: lazy-load
description: Defer or lazy-load heavy work so it only happens when actually needed
category: performance
---

# Lazy Load

Reach for this when startup, page load, or a request pays for work whose result is often unused.

1. Identify eager work that's expensive and not always needed: big imports, asset bundles, DB connections, precomputed data, or off-screen UI.
2. Move the work behind first use — lazy imports/`import()`, deferred initialization, computed-on-demand, or route/component code-splitting.
3. For UI/data, load on interaction or visibility (intersection observer, pagination, infinite scroll) instead of all up front.
4. Memoize the deferred result so the expensive work runs at most once, not on every access.
5. Add a lightweight placeholder/loading state and guard against repeated concurrent initialization (race on first use).
6. Measure the win — faster startup/first paint or smaller initial payload — and confirm deferred paths still work.

## Rules
- Lazy-loading trades first-use latency for faster startup; don't defer work that's needed immediately on the critical path.
- Always cache the result of a lazy init so you don't recompute on every call.
- Guard the first-use path against concurrent callers triggering the heavy work twice.
- Don't over-split — too many tiny lazy chunks add round-trips and can be slower than one bundle.
- Keep a visible loading/fallback state so deferred work doesn't look like a hang.
