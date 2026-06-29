---
name: connect-postgres
description: Connect ada to a Postgres database (read-only SQL) via the Postgres MCP server.
category: connectors
---

# Connect Postgres

Use when the user wants ada to inspect a schema or run read-only analytics queries against Postgres.

1. Add the connector: `ada mcp add postgres`.
2. Edit the connection string in `.ada/mcp.json` (the last arg) to point at your database — prefer a **read-only** role and a non-prod replica.
3. Keep credentials out of the file: use a role whose password is supplied via the environment or a `.pgpass`, not inline.
4. Trust the project and start `ada`; the tools appear as `postgres__*` (schema introspection + query).
5. Start by listing tables / describing the schema before writing any query.

## Rules
- Connect with a read-only user — never hand ada write/DDL credentials to "just query".
- Point at a replica or dev DB, not production, when possible.
- Review any generated SQL before running it on a large table; add `LIMIT` while exploring.
