---
name: gdpr-review
description: Review how the codebase collects, stores, and shares PII for GDPR compliance
category: compliance
---

# GDPR Review

Use when auditing a feature or service that touches personal data, or before shipping anything that collects user information into the EU/EEA scope.

1. Inventory PII: grep for fields and patterns (email, name, phone, IP, address, `user_id`, device IDs, geolocation, cookies) and list every place personal data enters the system.
2. Trace data flow for each item — where it is stored (DB tables, logs, caches, analytics, third-party SaaS), how long, and who it is shared with.
3. Check the legal basis and consent: is collection tied to a stated purpose, is consent recorded and revocable, and is data minimized to what the purpose needs.
4. Verify data-subject rights are implementable: export (portability), deletion/erasure, and rectification — confirm a delete actually purges across DB, backups policy, logs, and downstream processors.
5. Check protection controls: encryption at rest/in transit, access scoping, and that PII is not leaking into logs, error traces, URLs, or analytics events.
6. Confirm cross-border transfers and sub-processors have a lawful mechanism, and that retention/auto-expiry is enforced in code, not just documented.
7. Report findings ranked by risk with concrete file/line references and a remediation per gap.

## Rules
- Flag any PII written to plaintext logs, analytics, or third-party trackers without consent — this is a common and serious leak.
- "Soft delete" (a flag) does not satisfy erasure; verify the data is truly removed or anonymized.
- Pseudonymized data is still personal data if it can be re-linked; treat reversible hashing/IDs as PII.
- Do not assume backups are out of scope — note the retention and deletion policy for them.
- You are reviewing engineering controls, not giving legal advice; recommend legal/DPO sign-off for basis and contracts.
