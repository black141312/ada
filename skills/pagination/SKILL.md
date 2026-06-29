---
name: pagination
description: Add pagination to a list endpoint with a stable order and total/next signal
category: api
---

# Pagination

Reach for this when a list endpoint returns an unbounded collection and needs to page results predictably.

1. Pick a strategy: cursor-based for large/real-time data and infinite scroll, offset/limit for small or page-numbered UIs.
2. Define a deterministic sort with a tiebreaker (e.g. `created_at, id`) — pagination over a non-stable order skips or repeats rows.
3. Parse and clamp page params (`limit` with a sane max, `cursor` or `offset`); reject invalid values with 400.
4. Query for `limit + 1` rows (or a count) so you can tell whether a next page exists without a second round trip.
5. Return data plus metadata: `nextCursor`/`hasMore` for cursor, or `total`/`page`/`pageSize` for offset.
6. Add tests: first page, a middle page, the last page (no next), and an out-of-range/empty result.

## Rules
- Always enforce a maximum page size; an unbounded `limit` lets a client pull the whole table.
- Sort must be stable and total — include a unique tiebreaker or rows drift between pages on inserts/deletes.
- Cursors should encode the sort key, not a raw offset; opaque (base64) cursors discourage clients depending on internals.
- Avoid `COUNT(*)` on huge tables for every request if you only need "has more" — fetch `limit + 1` instead.
- Keep the response envelope consistent with other list endpoints in the codebase.
