---
name: call-graph
description: Map the callers and dependencies of a symbol to understand blast radius before changing it
category: code-understanding
---

# Call Graph

Use before modifying or removing a function, method, or type when you need to know who depends on it and what it depends on.

1. Pin down the exact symbol: its definition, signature, and the module/namespace that exports it.
2. Find callers — grep for the name across the repo, then filter out shadowing, comments, and unrelated same-name symbols.
3. Find dependencies — list the functions, types, and external modules this symbol calls or uses.
4. Follow indirection: interfaces/abstract methods, dynamic dispatch, dependency injection, event handlers, and re-exports that hide real call sites.
5. Note entry points that reach the symbol (HTTP routes, CLI commands, jobs, tests) so you know the real blast radius.
6. Summarize as inbound (callers) and outbound (dependencies), flagging anything public/exported or crossing a package boundary.

## Rules
- A grep for the bare name over-matches; confirm each hit is the same symbol, not a namesake.
- Account for indirect calls — interface implementations and string-keyed dispatch will not show as direct references.
- Treat exported/public symbols as having unknown external callers; say so when the repo is a library.
- Distinguish test-only callers from production callers; they imply different risk.
- Report concrete file:line references, not vague counts.
