---
name: data-validation
description: Add data-quality and schema checks that fail fast on bad data
category: data-ml
---

# Data Validation

Use when data enters a pipeline, a model, or a report and you need to catch schema drift, nulls, and out-of-range values before they cause silent corruption downstream.

1. Define the expected schema: column names, types, nullability, and allowed value ranges or sets.
2. Add structural checks (required columns present, types correct, primary key unique and non-null) at ingestion.
3. Add content checks: null rates within tolerance, numeric ranges, categorical domains, referential integrity, and freshness/row-count bounds.
4. Decide per-check severity — hard-fail and stop the pipeline, or warn and quarantine bad rows to a dead-letter table.
5. Wire checks into the pipeline as a gate before the load/train step, with clear error messages naming the failing column and rule.
6. Track validation results over time so gradual drift (rising null rate, shifting distribution) is visible, not just hard breaks.

## Rules
- Fail fast at the boundary; bad data is cheapest to catch before it's joined, aggregated, or trained on.
- Make failures specific — name the column, the rule, and example offending values, not just "validation failed".
- Separate hard failures from warnings; not every anomaly should halt the whole run.
- Check the unglamorous invariants too: row counts, freshness, and key uniqueness catch the most real incidents.
- Keep expectations versioned next to the data contract so schema changes are reviewed deliberately.
