---
name: graphql-resolver
description: Add a GraphQL resolver and its schema type, wired into the existing graph
category: api
---

# Graphql Resolver

Use when exposing new data or a mutation through GraphQL — you need a schema type plus the resolver that backs it.

1. Add or extend the SDL type (or code-first type) — define fields, nullability, and arguments; reuse existing scalars and enums.
2. Wire the field into the root `Query`/`Mutation` (or parent type) so the schema actually exposes it.
3. Implement the resolver, pulling shared services and the request `context` (auth, loaders) rather than instantiating clients inline.
4. Use a DataLoader (or equivalent batching) for any field that fetches per-parent to avoid N+1 queries.
5. Enforce auth/authorization inside the resolver or via a directive/middleware — never assume the gateway did it.
6. Regenerate typed bindings if the project uses codegen, then add a resolver test covering one success and one error/forbidden case.

## Rules
- Keep schema and resolver in sync; if codegen exists, run it and commit the generated output.
- Return GraphQL errors via the framework's error type (with extensions/codes), not by throwing raw strings.
- Batch with DataLoader for list-of-parents fields; a naive resolver silently becomes an N+1.
- Make nullability deliberate — non-null fields that can fail will null out the whole parent.
- Don't over-fetch: select only the columns/fields the resolver actually returns.
