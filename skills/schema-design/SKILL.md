---
name: schema-design
description: Design or normalize a database schema with sane keys, types, and relations
category: database
---

# Schema Design

Use when modeling a new feature's tables or untangling an existing schema that has grown redundant, ambiguous, or hard to query.

1. List the entities and the real-world relationships between them (1:1, 1:many, many:many) before writing any DDL.
2. Give every table a stable primary key; pick a surrogate key (auto-int or UUID) unless a natural key is truly immutable and unique.
3. Choose the tightest correct type for each column (e.g. `timestamptz` not text dates, `numeric` not float for money, enums/check constraints for fixed sets).
4. Normalize to 3NF first (no repeating groups, no transitive deps), then denormalize only where a measured read pattern demands it.
5. Add foreign keys with explicit `ON DELETE` behavior, and `NOT NULL` / `UNIQUE` / `CHECK` constraints to encode invariants in the DB, not just the app.
6. Resolve many:many with a join table; index the foreign-key columns you will filter or join on.

## Rules
- Let the database enforce integrity (FKs, constraints) — don't rely solely on application code.
- Prefer `timestamptz` and store times in UTC; name booleans as `is_`/`has_` flags.
- Avoid nullable columns that encode meaning; a separate table or status enum is usually clearer.
- Don't over-index up front — add indexes to match actual query and constraint needs.
- Use consistent naming (singular vs plural, snake_case) across the whole schema.
