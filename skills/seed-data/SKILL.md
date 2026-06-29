---
name: seed-data
description: Generate deterministic seed and fixture data for dev and test databases
category: database
---

# Seed Data

Use when you need realistic, repeatable data to populate a dev database or back a test suite, without hand-writing rows or depending on production dumps.

1. Decide the scope: a small idempotent dev seed (a few records per table) vs. per-test fixtures (minimal data for one scenario).
2. Insert in dependency order — parents before children — so foreign keys resolve; reuse the IDs you create downstream.
3. Use a faker/factory library or fixed literals; seed any RNG so the data is deterministic and reproducible across runs.
4. Make the seed idempotent: upsert or guard with "skip if already present" so re-running doesn't duplicate or crash.
5. Cover the edge cases tests actually need (empty strings, nulls, boundary numbers, unicode), not just the happy path.
6. Wire it to a single command (e.g. `npm run seed`, `make seed`, a migration's data step) and document how to reset.

## Rules
- Never point seed scripts at production or use real customer data; keep PII synthetic.
- Keep seeds idempotent — running twice must leave the same state.
- Isolate test fixtures per test (transaction rollback or truncate-between) so tests don't bleed state.
- Seed the smallest dataset that exercises the case; large seeds slow the suite for no gain.
- Keep seed data in version control and update it when the schema changes.
