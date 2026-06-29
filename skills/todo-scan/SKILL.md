---
name: todo-scan
description: Collect TODO/FIXME/HACK comments across the codebase into a triaged, actionable backlog
category: productivity
---

# Todo Scan

Reach for this when you want a single inventory of the inline debt scattered through code comments, turned into a backlog you can prioritize instead of a pile of grep hits.

1. Grep the tree for the marker set: `TODO`, `FIXME`, `HACK`, `XXX`, `BUG`, `OPTIMIZE` (case-insensitive), excluding `node_modules`, `vendor`, build, and lockfiles.
2. For each hit capture file path, line number, the marker type, and the full comment text plus a line or two of surrounding context.
3. Normalize duplicates and multi-line comments into one entry each; drop commented-out code and false positives (e.g. the word "todo" in a string or doc).
4. Tag every entry with a rough severity (blocker / should-fix / nice-to-have) and a guessed area (auth, db, ui, build, tests) from the path.
5. Sort by severity then area, and emit a Markdown table: marker, severity, location (`path:line`), summary.
6. Surface any entry that names a person, ticket id, or a date that has already passed — those are the highest-signal items.

## Rules
- Report `path:line` for every item so it is click-to-open; never paraphrase a location.
- Do not edit, resolve, or delete the comments — this skill only inventories them.
- Skip generated/vendored directories and minified files or the list drowns in noise.
- Distinguish marker types in output; a `FIXME` is not the same priority as an aspirational `TODO`.
- If the scan returns more than ~50 items, summarize counts per area first, then list the top items rather than dumping everything.
