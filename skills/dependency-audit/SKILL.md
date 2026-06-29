---
name: dependency-audit
description: Run npm/pip/etc audit, triage advisories, and apply the safest upgrades
category: security
---

# Dependency Audit

Use this to find and triage known-vulnerable third-party packages in a project's dependency tree.

1. Run the ecosystem auditor: `npm audit --json`, `pip-audit`, `pnpm audit`, `cargo audit`, or `osv-scanner -r .`; capture the raw output.
2. For each advisory note severity, whether it is a direct or transitive dependency, and if a fixed version exists.
3. Confirm reachability: check whether the vulnerable code path is actually called by this project — a CVE in an unused code path is lower priority.
4. Fix direct deps by bumping to the patched version; for transitive ones use overrides/resolutions (`overrides` in package.json, constraints file for pip) or upgrade the parent.
5. Re-run the auditor and the test suite to confirm the advisory clears and nothing broke.
6. Record any advisory you intentionally accept (no fix available, not reachable) with a dated justification.

## Rules
- Prioritize by severity AND reachability/exploitability, not by raw count of advisories.
- Pin to the minimal version that fixes the issue; avoid sweeping major-version bumps in the same change.
- Lockfiles must be regenerated and committed so the fix is reproducible.
- Beware audit noise: dev-only/build-time deps rarely warrant a risky upgrade — judge by where the package runs.
- Add the audit to CI (failing on high/critical) so regressions are caught automatically.
