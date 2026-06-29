---
name: security-review
description: Review the current diff for security vulnerabilities before it ships
category: review
---

# Security Review

Reach for this when a change touches auth, input handling, data access, secrets, or anything exposed to untrusted input, and you want a focused security pass before merging.

1. Scope the diff with `git diff` (or `git diff main...HEAD`) and list which files cross a trust boundary (network, user input, file system, env, subprocess).
2. Trace each untrusted input to its sink — look for injection (SQL/NoSQL/command/template), path traversal, SSRF, and unsafe deserialization.
3. Check authz/authn on every new or changed endpoint, handler, or query: is the caller's identity verified and are they allowed to touch this resource?
4. Grep the diff for hardcoded secrets, tokens, keys, and credentials; confirm none are logged or committed.
5. Inspect crypto, randomness, and session handling — flag weak hashes, predictable tokens, missing TLS verification, and `eval`-style dynamic execution.
6. For each finding, report file:line, the concrete attack, severity, and a minimal fix; verify the fix doesn't break the happy path.

## Rules
- Only flag issues reachable from untrusted input — don't pad the report with theoretical risks in trusted-only code paths.
- Assume all external input is hostile, including headers, query params, filenames, and webhook payloads.
- Never paste a discovered secret into output or logs; reference its location and recommend rotation.
- Prefer parameterized queries, allowlists, and existing framework escaping over hand-rolled sanitization.
- Rank findings by exploitability and blast radius, not by how many you found.
