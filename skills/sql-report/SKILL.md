---
name: sql-report
description: Write a correct, readable analytics SQL query or report
category: data-ml
---

# SQL Report

Use when answering an analytics question with SQL — metrics, cohorts, funnels, time series — where correctness of grain and joins matters more than cleverness.

1. State the question precisely: what's one row in the output (the grain), over what time window, and filtered how.
2. Identify the base tables and their grain; confirm join keys are unique on at least one side to avoid fan-out.
3. Build incrementally with CTEs — one logical step per CTE (filter, join, aggregate) — instead of nested subqueries.
4. Aggregate with explicit GROUP BY matching the SELECT, and use window functions for running totals, ranks, and period-over-period.
5. Guard against double counting from many-to-many joins; pre-aggregate to the right grain before joining.
6. Sanity-check totals against a known number, check for NULLs in keys, and review the row count.

## Rules
- Define the output grain first; most SQL bugs are a join that silently multiplies rows.
- Filter dates with half-open ranges (`>= start AND < end`) to avoid boundary and timezone errors.
- Beware aggregates over LEFT-joined NULLs — `COUNT(col)` skips NULLs, `SUM` treats them as zero; be intentional.
- Name CTEs for what they represent; avoid `SELECT *` in reports so the contract is explicit.
- Verify with a small spot-check (a single known entity) before trusting the aggregate.
