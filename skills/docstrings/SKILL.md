---
name: docstrings
description: Add docstrings or JSDoc to public APIs describing behavior, params, returns, and errors
category: docs
---

# Docstrings

Use this to document the public surface of a module or package so callers understand it without reading the implementation. Focus on exported/public symbols, not every internal helper.

1. Identify the public API: exported functions, classes, methods, and constants that callers depend on.
2. Pick the idiomatic format for the language (JSDoc/TSDoc, Python PEP 257 + type-style, Rustdoc `///`, GoDoc comment).
3. For each symbol, write a one-line summary, then document params, return value, thrown/raised errors, and side effects.
4. Describe behavior and contracts (units, ranges, nullability, ownership) — not a restatement of the signature.
5. Add a short usage example for anything non-obvious or easy to misuse.
6. Run the doc/lint tooling (`tsc`, `pydocstyle`, `cargo doc`, `go doc`) to confirm the comments parse.

## Rules
- Document why and how-to-use, never "this function does X" when X is just the name.
- Don't restate types the signature already conveys; add the constraints it can't.
- Keep summaries to one imperative line; details go below.
- Cover error/exception cases and edge behavior — that's what callers can't infer.
- Skip private/internal helpers unless their behavior is genuinely surprising.
