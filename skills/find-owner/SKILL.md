---
name: find-owner
description: Locate where a feature or behavior lives in the codebase starting from a symptom or user-facing string
category: code-understanding
---

# Find Owner

Use when you know what the software does but not where the code is — "where is the discount applied?" or "what renders this error?" Start from observable anchors and work inward.

1. Extract searchable anchors: user-facing strings, error messages, log lines, route paths, config keys, or feature-flag names.
2. Grep for the most literal anchor first; exact strings beat guessed identifiers.
3. From a hit, walk outward to the owning function/module and confirm it matches the behavior, not just the wording.
4. If the string is composed or templated, search for its stable fragments or the format template instead of the full text.
5. Cross-check with git history (`git log -S` / blame) to find when and where the behavior was introduced.
6. Report the owning file(s) and entry function, plus adjacent code (tests, config) that confirms it is the right place.

## Rules
- Strings shown to users are the strongest anchors — prefer them over guessing function names.
- Watch for interpolation, i18n keys, and concatenation that prevent a full-string match; fall back to fragments.
- Confirm the candidate actually produces the behavior; a matching string can live in dead code or a comment.
- Use `git log -S"<snippet>"` to pinpoint the introducing commit when grep alone is ambiguous.
- If the behavior comes from a dependency or generated code, say so rather than forcing a match in app source.
