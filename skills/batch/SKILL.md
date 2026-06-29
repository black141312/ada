---
name: batch
description: Batch requests/operations to cut per-call overhead and round-trips
category: performance
---

# Batch

Reach for this when many small, similar operations each pay fixed overhead — network round-trips, DB statements, or API calls in a loop.

1. Find the chatty loop: per-item HTTP calls, single-row inserts, or one API request per element when a bulk form exists.
2. Group items into batches and use the bulk primitive — `INSERT ... VALUES (many)`, `WHERE id IN (...)`, bulk/multi endpoints, or a pipeline.
3. Choose a batch size that balances throughput against memory and payload limits; chunk large sets rather than one giant call.
4. Optionally add a short time-window or size-trigger buffer (debounce/flush) to accumulate items before sending.
5. Handle partial failure: know whether the batch is atomic or per-item, and retry or report the failed subset without redoing successes.
6. Measure round-trips and total time before/after to confirm the overhead reduction is real.

## Rules
- Batch the overhead, not the work — the win comes from fewer round-trips, not less computation.
- Cap batch size; an unbounded batch hits payload limits, timeouts, or memory blowups.
- Respect ordering and idempotency — retries on a partially-applied batch must not double-apply.
- Don't add buffering/debounce latency to operations that need to be immediate.
- Preserve per-item error reporting so one bad item doesn't silently sink the whole batch.
