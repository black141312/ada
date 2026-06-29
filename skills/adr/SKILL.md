---
name: adr
description: Write an Architecture Decision Record capturing context, the decision, and consequences
category: docs
---

# Adr

Use this to record a significant, hard-to-reverse technical decision so the reasoning survives past the people who made it. One ADR per decision, immutable once accepted.

1. Find or create `docs/adr/` (or `doc/decisions/`); number the new file sequentially, e.g. `0007-use-postgres.md`.
2. Write a short noun-phrase title describing the decision.
3. Set Status: Proposed, then Accepted (or later Deprecated/Superseded by ADR-NNNN).
4. Context: the forces, constraints, and problem driving the decision — neutral, no conclusion yet.
5. Decision: state what you're doing in active voice ("We will use ...").
6. Consequences: the resulting trade-offs, both positive and negative, including what becomes harder.
7. List the alternatives considered and why each was rejected.

## Rules
- One decision per record; keep it to a page.
- ADRs are immutable — to change course, write a new ADR that supersedes the old one, don't edit it.
- Capture the why and the rejected options; that context is the whole point.
- Be honest about downsides in Consequences — every real decision has them.
- Keep filenames numbered and titles stable so cross-references hold.
