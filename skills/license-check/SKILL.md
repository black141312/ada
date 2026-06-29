---
name: license-check
description: Audit dependency licenses for compliance and flag copyleft or unknown-license packages
category: dependencies
---

# License Check

Use before a release, an open-source publish, or a legal review to confirm every dependency's license is acceptable.

1. Generate a full license inventory including transitive deps (`license-checker`, `pip-licenses`, `cargo-deny`, `cargo-about`, an SBOM tool).
2. Define the allowlist/denylist for the project (e.g. allow MIT/BSD/Apache-2.0, deny GPL/AGPL for proprietary code).
3. Flag anything copyleft, dual-licensed, custom, or reported as UNKNOWN/UNLICENSED for closer review.
4. For each flagged package, find the actual obligation (attribution, source disclosure, network-use clause) before deciding.
5. Resolve issues: replace the offending dependency, isolate it, or document the obligation and add required attribution/NOTICE.
6. Wire the check into CI so a new non-compliant license fails the build instead of slipping in.

## Rules
- Audit the whole transitive tree, not just direct dependencies — risk usually hides deep.
- "UNKNOWN" means missing metadata, not safe — chase down the real license manually.
- Copyleft (GPL/AGPL) in a proprietary product is a blocker; LGPL and weak-copyleft have nuance — read the terms.
- Permissive licenses still carry attribution duties; ship a NOTICE/THIRD-PARTY file to satisfy them.
- Re-run on every dependency change; a transitive bump can silently introduce a new license.
