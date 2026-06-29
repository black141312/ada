---
name: glossary
description: Build a glossary of domain and project terms so docs and code use one shared, unambiguous vocabulary.
category: docs
---

# Glossary

Use when a project has overloaded or insider terms ("tenant", "job", "account") that mean different things to different people — a glossary fixes the canonical meaning.

1. Harvest terms from code identifiers, docs, schemas, and onboarding questions; flag any word used two ways.
2. For each term write a one-sentence definition in plain language, then add nuance only if needed.
3. Note synonyms and explicitly call out "not to be confused with" near-misses.
4. Add a tiny concrete example or the canonical code/type it maps to (`Order → orders table, OrderEntity`).
5. Sort alphabetically with stable anchors so terms are deep-linkable from other docs.
6. Cross-link related terms and link the glossary from the docs landing page and CONTRIBUTING.
7. Assign an owner and review on schema/domain changes so definitions track reality.

## Rules
- One canonical definition per term — if a word legitimately means two things, that's two entries with disambiguators.
- Define in plain words; don't define a term using three other undefined terms.
- Tie each term to its concrete artifact (table, type, endpoint) where one exists.
- Keep entries short; a glossary is a lookup, not an essay.
- Update the glossary in the same PR that renames or repurposes a domain term.
