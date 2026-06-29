---
name: contract-audit
description: Audit a smart contract for security vulnerabilities and report findings by severity
category: web3
---

# Contract Audit

Use when reviewing a Solidity contract for exploitable bugs before deployment or when triaging a reported issue. Be adversarial: assume every external call is hostile.

1. Map the surface: list all external/public functions, who can call them, and which ones move value or change privileged state.
2. Trace value flows and trust boundaries; flag every external call, `delegatecall`, and low-level `call`/`transfer`.
3. Hunt the classic classes: reentrancy, integer/rounding errors, unchecked return values, access-control gaps, front-running/MEV, oracle/price manipulation, and unbounded loops (DoS).
4. Check upgradeability and init: uninitialized proxies, storage-layout collisions, missing `initializer` guards, and dangerous `selfdestruct`.
5. Run tooling: `slither`, `aderyn`, fuzz/invariant tests (`forge test`), and diff against known-good library versions.
6. Rate each finding (Critical/High/Medium/Low/Informational) with impact, a concrete exploit scenario, and a fix.
7. Re-verify after fixes — confirm the patch closes the issue without opening a new one.

## Rules
- Confirm exploitability with a PoC test or a precise call sequence; do not report theoretical noise as High.
- Reentrancy: verify checks-effects-interactions, not just the presence of a guard.
- Treat any external/oracle data as attacker-controlled until proven otherwise.
- Check for missing access modifiers on initializers, setters, and withdrawal functions.
- Flag floating pragmas and outdated/vulnerable dependency versions.
- Never modify contract logic silently during an audit — report, then fix in a separate, reviewed change.
