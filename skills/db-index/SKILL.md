---
name: db-index
description: Add the right database indexes for slow queries using EXPLAIN, not guesswork
category: performance
---

# DB Index

Reach for this when a query is slow because the database scans far more rows than it returns.

1. Identify the slow query from logs/APM and run `EXPLAIN ANALYZE` (or the engine's equivalent) to see the plan and row counts.
2. Look for sequential/full scans, high "rows examined vs rows returned" ratios, and filesorts on large tables.
3. Index the columns in `WHERE`, `JOIN`, and `ORDER BY`; build a composite index in the order equality-first, then range, then sort.
4. Create the index concurrently/online on production (`CREATE INDEX CONCURRENTLY`, or online DDL) to avoid locking the table.
5. Re-run `EXPLAIN ANALYZE` and confirm the planner uses the new index and rows-examined drops.
6. Verify write-path cost is acceptable — each index slows inserts/updates, so drop indexes that don't earn their keep.

## Rules
- Always read the query plan before and after — never add an index on a hunch.
- Composite index column order matters: leftmost prefix must match the query's filter/sort.
- Prefer covering indexes (include selected columns) to avoid heap lookups on hot reads.
- High-cardinality columns benefit most; indexing a low-cardinality boolean rarely helps.
- Build large indexes concurrently/online and off-peak to avoid blocking writes.
- More indexes is not better — they bloat storage and slow every write; remove unused ones.
