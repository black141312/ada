---
name: sanitize
description: Fix injection, XSS, and path-traversal bugs by parameterizing, encoding, and confining paths
category: security
---

# Sanitize

Use this to remediate a concrete injection-class bug: SQL/command injection, XSS, or path traversal where untrusted input reaches a dangerous sink.

1. Identify the sink and the injection class: query string, shell command, HTML/JS output, or filesystem path built from user input.
2. SQL/NoSQL injection: replace string concatenation with parameterized queries / prepared statements or an ORM binding — never interpolate input into the query.
3. Command injection: avoid the shell entirely — use an args array (`execFile`/`subprocess.run([...], shell=False)`); if a shell is unavoidable, allowlist and escape.
4. XSS: encode output for its context (HTML body, attribute, JS, URL); render via the framework's auto-escaping; for rich HTML use a vetted sanitizer (DOMPurify) and a strict CSP.
5. Path traversal: resolve the canonical path and assert it stays within an allowed base dir; reject `..`, absolute paths, and symlinks that escape; prefer an id-to-path map.
6. Add a regression test that feeds the malicious payload and asserts it is now neutralized.

## Rules
- Fix at the sink with the right primitive (parameterize, encode, confine) — input filtering alone is bypassable.
- Encode for the exact output context; HTML-escaping does not protect a JS or URL context.
- Disable shell interpolation by default; pass arguments as a list, not a concatenated string.
- Canonicalize paths before the boundary check, then verify the result is under the base directory.
- Keep a regression test per payload so the hole cannot silently reopen.
