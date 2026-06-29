---
name: etl-pipeline
description: Build an ETL/data pipeline that extracts, transforms, and loads data idempotently
category: data-ml
---

# ETL Pipeline

Reach for this when moving data between systems (files, APIs, databases, warehouses) on a schedule or one-shot, and you need it to be re-runnable without duplicating or corrupting data.

1. Pin down source and sink contracts: schema, primary keys, volume, update frequency, and whether the source is append-only or mutable.
2. Split the job into explicit extract, transform, and load stages so each can be tested and re-run in isolation.
3. Make loads idempotent: upsert on a natural/surrogate key, or stage-then-swap, so a re-run never double-writes.
4. Process incrementally using a watermark (updated_at, sequence id, or partition) and persist the high-water mark after a successful load.
5. Validate row counts and key invariants between stages; fail loud and stop before loading bad data downstream.
6. Add structured logging and a dead-letter path for bad records, then wire retries with backoff on transient failures.
7. Make the run parameterized (date range, env) and schedulable via cron/Airflow/Prefect rather than hardcoded.

## Rules
- Never mutate the source; treat raw extracts as immutable and transform into a separate layer.
- Idempotency is non-negotiable — assume every run can be retried or run twice.
- Keep transforms pure and deterministic; isolate I/O so logic is unit-testable without the network.
- Checkpoint the watermark only after the load commits, never before.
- Surface partial failures explicitly; a green exit code must mean the data is actually correct.
