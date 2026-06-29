---
name: security-audit
description: Scan the codebase for common vulnerabilities and rank findings by exploitability
category: security
---

# Security Audit

Reach for this when you want a broad first-pass sweep of a repo for security bugs before a release, audit, or handoff.

1. Map the attack surface: enumerate entry points (HTTP routes, CLI args, message consumers, file uploads, deserializers) and where untrusted data enters.
2. Grep for dangerous sinks: `eval`, `exec`, `child_process`, raw SQL string concatenation, `dangerouslySetInnerHTML`, `pickle.loads`, `yaml.load`, `os.system`, template rendering with user input.
3. Trace tainted data from each entry point to each sink; flag any path where user input reaches a sink without validation or parameterization.
4. Check auth/session handling, secrets management, crypto usage (no MD5/SHA1 for passwords, no hardcoded keys/IVs), and CORS/CSRF config.
5. Run available scanners (`semgrep --config auto`, `bandit`, `gosec`, `npm audit`) and merge their hits with your manual findings, deduping.
6. Rank each finding by severity x exploitability, write a one-line repro/impact, and propose the minimal fix.

## Rules
- Confirm a real data flow before reporting; a dangerous function alone is not a vuln if input is trusted/constant.
- Prefer parameterized queries, allowlists, and library escaping over hand-rolled sanitizers.
- Never paste real secrets or live tokens into the report; redact to last 4 chars.
- Separate "exploitable now" from "defense-in-depth" so the team fixes the bleeding first.
- Cite file:line for every finding so it can be verified independently.
