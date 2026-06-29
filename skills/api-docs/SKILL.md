---
name: api-docs
description: Generate API reference docs from the code, grouped by module with signatures and examples
category: docs
---

# Api Docs

Reach for this to produce a reference that lists every public endpoint, function, or class with its signature and contract. Distinct from a tutorial: this is exhaustive lookup material, not a guided walkthrough.

1. Decide the API surface: HTTP routes, exported library symbols, or CLI commands — and where docs should live (`docs/`, `/reference`).
2. Prefer a generator that reads the source of truth: OpenAPI/Swagger from route defs, TypeDoc/Sphinx/rustdoc/godoc from doc-comments.
3. If generating, ensure source comments/annotations are complete first, then run the generator and commit its config.
4. If writing by hand, group by module/resource; for each entry give signature, params, return/response, errors, and status codes.
5. Add at least one request/response or call example per entry, with realistic values.
6. Cross-link related entries and note auth, versioning, and deprecations.
7. Build the docs and verify examples against the running code or test suite.

## Rules
- Derive from the code so docs can't silently drift; wire generation into CI if it exists.
- Every entry needs an example — a signature alone isn't reference documentation.
- Document error responses and edge cases, not just the happy path.
- Mark deprecated and unstable APIs explicitly with the version they changed.
- Keep ordering stable (alphabetical or by resource) so diffs stay readable.
