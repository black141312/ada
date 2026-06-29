---
name: query-optimize
description: Optimize a slow SQL query using EXPLAIN, indexes, and rewrites
category: database
---

# Query Optimize

Use when a specific query is slow and you need to find and fix the bottleneck with evidence, not guesses.

1. Reproduce the slowness and capture the plan with `EXPLAIN ANALYZE` (or the engine's equivalent) on representative data volumes.
2. Read the plan for the real cost: sequential scans on large tables, nested loops over big row counts, expensive sorts, and bad row-count estimates.
3. Add or fix indexes to cover the `WHERE`, `JOIN`, and `ORDER BY` columns; consider composite indexes ordered by selectivity and partial indexes for filtered queries.
4. Rewrite the query where the plan demands it: avoid `SELECT *`, replace correlated subqueries with joins, push filters earlier, and avoid functions on indexed columns (they defeat the index).
5. Re-run `EXPLAIN ANALYZE` and confirm the plan improved and wall-clock time dropped on real data sizes.
6. Update table statistics (`ANALYZE`) and check for N+1 patterns if the query comes from an ORM.

## Rules
- Measure before and after with `EXPLAIN ANALYZE` on production-like data — small dev tables hide scan costs.
- An index helps reads but costs writes and storage; justify each one against the workload.
- Filter and sort on indexed expressions; wrapping a column in a function or leading-wildcard `LIKE` skips the index.
- Fix the query and indexes before reaching for caching or denormalization.
- Re-check the plan after the change; the optimizer may pick a different path than you expect.
