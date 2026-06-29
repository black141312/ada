---
name: migration
description: Write a forward/backward database migration that applies and rolls back cleanly
category: database
---

# Migration

Reach for this when you need to change a database schema (add/alter/drop columns, tables, indexes, constraints) in a way that is versioned, reviewable, and reversible.

1. Inspect the current schema and existing migrations to match naming, ordering, and the tool in use (e.g. Alembic, Prisma, Knex, Rails, raw SQL).
2. Write the `up` step: the smallest set of DDL/DML that achieves the change; split risky data backfills into their own step.
3. Write the `down` step that exactly reverses `up` (drop what you created, restore what you altered); never leave it as a no-op if `up` is reversible.
4. For non-trivial column changes, use the expand/contract pattern: add new, backfill, switch reads/writes, then drop old in a later migration.
5. Apply the migration on a scratch/dev database, then roll it back, then re-apply to prove both directions work.
6. Wrap each migration in a transaction where the engine allows it; flag operations that can't run transactionally (e.g. Postgres `CREATE INDEX CONCURRENTLY`).

## Rules
- One logical change per migration; never edit a migration that has already shipped — add a new one.
- Make column adds nullable or defaulted so they don't lock/fail on populated tables.
- Backfill large tables in batches, not a single `UPDATE`, to avoid long locks.
- Test `down` for real; an irreversible migration must say so explicitly and explain the recovery path.
- Keep migrations free of app code/ORM model imports so they still run after the models change.
