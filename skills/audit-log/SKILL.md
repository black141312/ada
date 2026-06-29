---
name: audit-log
description: Add a tamper-evident audit log of security-relevant actions with who/what/when
category: observability
---

# Audit Log

Reach for this when you must record who did what to which resource and when — for compliance, security forensics, or accountability.

1. Define the events worth auditing: authentication, authorization changes, data access/exports, config and permission changes, and admin actions.
2. Design a stable record schema: `actor` (id + type), `action`, `resource` (type + id), `timestamp` (UTC), `source_ip`, `outcome`, and a `correlation_id`.
3. Write audit records to a separate, append-only store (dedicated table/stream), never the same mutable rows the app edits, and never only to app logs.
4. Make it tamper-evident: hash-chain each entry (`hash = H(prev_hash + entry)`) or use a WORM/immutable backend so silent edits are detectable.
5. Emit the record in the same transaction as the action where possible so an action can't succeed without its audit trail.
6. Restrict write/read access, set a retention policy matching your compliance regime, and add a verification job that walks the hash chain to detect breaks.

## Rules
- Audit logs are append-only — no updates or deletes outside the retention policy.
- Record the outcome (success/denied/error), not just attempts; failed-access events are the point.
- Don't store raw secrets or full sensitive payloads — log identifiers and the fact of access.
- Use a trusted server-side clock in UTC; never trust client-supplied timestamps.
- Separate audit storage and permissions from application data so an app compromise can't rewrite history.
