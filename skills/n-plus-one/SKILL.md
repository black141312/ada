---
name: n-plus-one
description: Find and fix N+1 query problems by eager-loading or batching the per-row queries
category: performance
---

# N Plus One

Reach for this when an endpoint fires one query per row of a result set — the classic N+1 that scales linearly with data.

1. Spot the pattern: a query returns N rows, then a loop (or lazy relation access) issues one more query per row to fetch related data.
2. Confirm it in query logs or APM — look for the same statement repeated N times with only the id parameter changing.
3. Replace per-row loads with a single batched fetch: ORM eager loading (`includes`/`joinedload`/`prefetch_related`/`with`) or one `WHERE id IN (...)`.
4. For nested relations, eager-load the whole chain so child loops don't reintroduce N+1 at the next level.
5. Re-run and verify the query count collapses from N+1 to a small constant (1-3).
6. Add a test or dev-time assertion that fails on excessive query counts to prevent regressions.

## Rules
- Diagnose by query count, not wall time — N+1 hides on small datasets and explodes in production.
- Prefer the ORM's eager-load over hand-rolled loops; reach for `IN (...)` batching when the ORM can't.
- Watch serializers and view templates — lazily accessing a relation inside a render loop is a common hidden source.
- Don't fix N+1 by pulling the whole table into memory; batch by the ids you actually need.
- Cap or paginate the `IN (...)` list so a huge result set doesn't create one giant query.
