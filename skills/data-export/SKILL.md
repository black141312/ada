---
name: data-export
description: Export and transform database data to CSV or JSON safely and reproducibly
category: database
---

# Data Export

Use when extracting query results or table contents into CSV/JSON for reporting, sharing, backups, or feeding another system.

1. Define exactly what to export: the query or table, the columns, and the row scope (filters, date range) — avoid dumping more than needed.
2. Stream or paginate large result sets rather than loading everything into memory at once.
3. Serialize with a real CSV/JSON library so quoting, escaping, delimiters, encoding (UTF-8), and nulls are handled correctly — don't hand-concatenate strings.
4. Normalize types on the way out: format timestamps to ISO 8601, fix numeric precision, and encode nulls/booleans consistently.
5. Redact or omit sensitive fields (PII, secrets, tokens) and confirm the destination of the file is appropriate for its sensitivity.
6. Verify the output: row count matches the query, a sample re-imports cleanly, and the file opens in the target tool.

## Rules
- Never build CSV/JSON by string concatenation — embedded commas, quotes, and newlines will corrupt it.
- Stream large exports; loading millions of rows into memory will OOM the process.
- Always emit UTF-8 and be explicit about delimiter and quoting so downstream tools parse it.
- Scrub sensitive columns before export and never write secrets to a shared or world-readable file.
- Make exports reproducible: deterministic ordering (`ORDER BY`) and a recorded query, so the same inputs yield the same file.
