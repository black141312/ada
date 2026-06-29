---
name: threat-model
description: Produce a quick STRIDE-based threat model for a feature with ranked threats and mitigations
category: security
---

# Threat Model

Use this when designing or reviewing a feature to surface what can go wrong before it ships — a lightweight, decision-ready threat model.

1. Scope it: state the feature, its assets (data, money, capabilities), the actors (users, admins, external services, attackers), and the trust boundaries.
2. Sketch the data flow: entry points, components, data stores, and where data crosses a trust boundary (these are the interesting spots).
3. Enumerate threats per boundary using STRIDE (Spoofing, Tampering, Repudiation, Info disclosure, Denial of service, Elevation of privilege).
4. Rank each threat by likelihood x impact; drop the implausible ones to keep the model actionable.
5. Assign each top threat a mitigation (control, design change, or accepted-risk) and who/what enforces it.
6. List residual risks and any assumptions the design depends on (e.g. "TLS terminates upstream", "tenant id is trusted from gateway").

## Rules
- Keep it lean and decision-oriented — a one-page model that ships beats an exhaustive one that does not.
- Anchor on trust boundaries; most real threats live where data or control crosses one.
- Every retained threat needs an owner-able mitigation or an explicit accepted-risk note.
- State assumptions plainly — an unvalidated assumption is a future vulnerability.
- Revisit the model when the feature's data flow or trust boundaries change.
