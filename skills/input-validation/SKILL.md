---
name: input-validation
description: Add validation and sanitization at trust boundaries where untrusted data enters
category: security
---

# Input Validation

Use this when adding or hardening checks on data crossing a trust boundary — request bodies, query params, headers, file uploads, env, or upstream API responses.

1. Identify each trust boundary and the exact shape expected (type, range, length, format, allowed values) for every field.
2. Validate at the boundary with a schema/validator (zod, pydantic, JSON Schema, Joi) — parse into typed values, reject anything that does not conform.
3. Prefer allowlists over denylists: enumerate what is permitted (enum, regex anchored with `^...$`, numeric bounds) rather than blocking known-bad.
4. Enforce size and depth limits (max length, max array size, max upload bytes, max JSON nesting) to blunt resource-exhaustion.
5. Apply context-correct encoding/escaping at the sink (SQL params, HTML escape, shell arg arrays) — validation does not replace output encoding.
6. Fail closed with a clear, non-leaky error; log the rejection for monitoring without echoing raw payloads.

## Rules
- Validate on the server even if the client already validates — the client is untrusted.
- Normalize before validating (Unicode, path, case) so checks cannot be bypassed by alternate encodings.
- Validate is not the same as sanitize: reject bad input where you can; only transform when you must.
- Keep validation declarative and centralized so it is auditable, not scattered ad-hoc checks.
- Anchor regexes and set timeouts/limits to avoid ReDoS on attacker-controlled strings.
