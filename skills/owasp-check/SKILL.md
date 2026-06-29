---
name: owasp-check
description: Check a web app against the OWASP Top 10 and report concrete gaps per category
category: security
---

# OWASP Check

Use this for a structured web-app review walking each OWASP Top 10 category and producing concrete, located findings.

1. A01 Broken Access Control: check object-level authz, IDOR, missing server-side checks, and forced browsing to admin routes.
2. A02/A04/A05 Crypto, Insecure Design, Misconfig: verify TLS, password hashing (bcrypt/argon2 not MD5/SHA1), secure headers, disabled debug, no default creds.
3. A03 Injection: trace user input to SQL/NoSQL/OS/LDAP/template sinks; confirm parameterization and output encoding.
4. A06/A08 Vulnerable Components & Integrity: run dependency audit, check for unsigned/untrusted updates and unsafe deserialization.
5. A07 Auth Failures: review session expiry/rotation, brute-force throttling, MFA, and credential-stuffing protections.
6. A09/A10 Logging & SSRF: confirm security events are logged (without secrets) and that server-side fetches validate/allowlist destinations.
7. Summarize per category as Pass / Gap / N-A with file:line evidence and a fix for each gap.

## Rules
- Walk all ten categories explicitly so nothing is silently skipped; mark N/A where it genuinely does not apply.
- Back every "Gap" with a concrete location and, where possible, a repro — avoid generic advice.
- Lean on existing skills (authz-review, dependency-audit, sanitize) rather than re-deriving them here.
- Distinguish exploitable findings from hardening recommendations.
- Reference the current OWASP Top 10 list version you are checking against.
