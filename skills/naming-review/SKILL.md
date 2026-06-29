---
name: naming-review
description: Flag unclear names in the diff and suggest sharper replacements
category: review
---

# Naming Review

Reach for this when reviewing a change where names carry the meaning — new functions, variables, types, flags, or files — and you want them to read clearly at the call site.

1. Run `git diff` and collect every newly introduced or renamed identifier (functions, variables, types, params, files, config keys).
2. For each, ask whether the name says what it is or does without needing the implementation — flag vague ones (`data`, `tmp`, `handle`, `doStuff`, `flag2`).
3. Check booleans read as predicates (`isReady`, `hasItems`), and that functions are verbs while values are nouns.
4. Watch for misleading names (a `list` that's a map), inconsistent vocabulary for the same concept, and unexplained abbreviations.
5. Propose a concrete better name for each flagged identifier and note where it's used so the rename is mechanical.
6. Apply low-risk renames in the working tree; leave wide-blast-radius ones as suggestions for the author to confirm.

## Rules
- Judge a name by how it reads at the call site, not at the definition.
- Match the codebase's existing conventions — don't introduce a competing vocabulary for the same idea.
- Prefer clear and slightly longer over clever and cryptic; avoid single letters outside tight loops.
- Don't bikeshed already-fine names; only flag ones that genuinely cost a reader time.
- Flag misleading names as higher priority than merely-vague ones — wrong is worse than fuzzy.
