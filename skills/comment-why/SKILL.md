---
name: comment-why
description: Add why-comments to non-obvious code explaining intent, constraints, and gotchas
category: docs
---

# Comment Why

Use this when code is correct but mysterious — a magic constant, a workaround, an ordering that matters. Comment the reasoning the code can't express, not the mechanics it already shows.

1. Scan the target code for non-obvious spots: magic numbers, workarounds, defensive checks, surprising ordering, perf hacks.
2. For each, work out the why: the bug it prevents, the constraint it satisfies, the assumption it relies on.
3. Write a short comment stating intent — link an issue/spec/RFC or cite the source when relevant.
4. Flag landmines explicitly (`// HACK:`, `// WARNING:`, `// SAFETY:`) so future editors pause.
5. Delete or fix any comment that merely restates the code or has gone stale.
6. Re-read each comment cold and confirm it would actually save a future reader time.

## Rules
- Explain why, never what — `i += 2` doesn't need "increment i by 2".
- Anchor claims: link the issue, ticket, or upstream bug instead of vague "for compatibility".
- Don't narrate obvious code; noise comments are worse than none.
- Put the comment next to the surprising line, not in a distant block.
- A comment is a liability — if it can drift out of sync, prefer making the code self-explaining.
