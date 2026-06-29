---
name: rest-endpoint
description: Scaffold a REST endpoint with handler, input validation, and tests
category: api
---

# Rest Endpoint

Reach for this when adding a new HTTP route (GET/POST/PUT/PATCH/DELETE) that needs a handler, validated input, and coverage.

1. Find the existing routing layer and copy the nearest sibling endpoint's structure (router registration, file layout, naming).
2. Define request/response shapes: path params, query params, and body — derive types from the validation schema, don't hand-write both.
3. Validate input at the boundary (e.g. zod/pydantic/joi) and return 400 with field-level errors on failure before any business logic.
4. Implement the handler: call the service/data layer, never inline DB queries in the route if the codebase separates them.
5. Map errors to status codes deliberately — 404 not-found, 409 conflict, 422 unprocessable, 401/403 auth — and avoid leaking internals in 500s.
6. Register the route and write tests: happy path, one validation-failure case, and one auth/not-found case.

## Rules
- Match the project's existing conventions (status codes, error envelope, casing) over any external "best practice".
- Validate and parse untrusted input before it reaches business logic; reject unknown fields if the codebase does.
- Keep handlers thin — orchestration only; push logic into services so it's unit-testable.
- Use the correct verb and idempotency: POST creates, PUT/PATCH update, DELETE is idempotent.
- Never return raw exception messages or stack traces to clients.
