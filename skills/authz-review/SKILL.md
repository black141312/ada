---
name: authz-review
description: Review authentication and authorization logic for missing or broken access checks
category: security
---

# Authz Review

Use this to audit who-can-do-what: missing access checks, broken object-level authorization (IDOR), and privilege escalation paths.

1. List every protected resource and action, then map which endpoint/handler serves each and what check it performs.
2. Verify each handler enforces BOTH authentication (who you are) and authorization (what you may touch) — and that authorization is object-level, not just "is logged in".
3. Hunt for IDOR: any handler that reads an id from the request and fetches the record without scoping to the current user/tenant.
4. Check role/permission logic for default-allow, missing server-side enforcement (client-only gating), and admin routes lacking checks.
5. Inspect token/session handling: expiry, revocation, signature verification, and that role/tenant claims are server-validated, not trusted from the client.
6. Write a test (or curl repro) proving an unauthorized actor is now blocked for each gap found.

## Rules
- Default deny: access must be explicitly granted, never implicitly assumed.
- Enforce authorization on the server for every request — UI hiding is not a control.
- Scope every record lookup by owner/tenant; never trust an id alone from the client.
- Re-check authorization on every step of multi-step flows, not just the first.
- Confirm fixes with a negative test (the forbidden action returns 403/404), not just a happy-path test.
