---
name: dataframe
description: Transform tabular data with pandas or polars cleanly and reproducibly
category: data-ml
---

# Dataframe

Use when wrangling tabular data — cleaning, reshaping, joining, aggregating — with pandas or polars, and you want correct, readable, vectorized code.

1. Load with explicit dtypes (and parse dates) so columns don't silently become object/float; check `df.dtypes` and shape first.
2. Inspect before transforming: nulls per column, value ranges, duplicates, and cardinality of key columns.
3. Build the transform as a chain of vectorized ops (filter, assign/with_columns, groupby/agg, merge/join) — avoid `iterrows`/Python loops.
4. Be explicit about join keys and `how`; verify row count after each join to catch fan-out from non-unique keys.
5. Handle missing data deliberately (drop, fill, or flag) rather than letting NaN propagate into aggregates.
6. Validate the output shape, dtypes, and a few known values before writing; persist to a columnar format (Parquet) when possible.

## Rules
- Prefer vectorized/expression APIs over `apply` with Python functions; reach for `apply` only as a last resort.
- Avoid chained-assignment on slices in pandas (use `.loc`); in polars build new frames with expressions.
- Always validate row counts around joins and groupbys — silent fan-out and dropped rows are the top bugs.
- Set dtypes at read time; don't rely on inference for ids, categoricals, or money.
- Keep transforms as a pure function of the input frame so the same input always yields the same output.
