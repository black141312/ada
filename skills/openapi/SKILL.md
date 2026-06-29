---
name: openapi
description: Write or update an OpenAPI spec so it matches the actual API behavior
category: api
---

# Openapi

Reach for this when documenting an API in OpenAPI/Swagger, or keeping an existing spec in sync after an endpoint changes.

1. Locate the existing spec (`openapi.yaml`/`.json`) and confirm the version (3.0 vs 3.1) before editing — syntax differs.
2. Define or update the `paths` entry: method, parameters, `requestBody`, and every response status the handler can return.
3. Factor request/response shapes into `components/schemas` and reference with `$ref` instead of inlining duplicates.
4. Document auth via `securitySchemes` and apply `security` at the operation or root level to match real enforcement.
5. Add realistic `examples` and mark required fields and formats (`date-time`, `uuid`, `email`) so consumers and mocks behave.
6. Validate the spec with a linter (e.g. `spectral lint`/`swagger-cli validate`) and, if codegen is used, regenerate clients/types.

## Rules
- The spec must describe what the code does, not what you wish it did — verify against the handler.
- Document error responses (4xx/5xx), not just the 200 — consumers need the failure shapes.
- Reuse `$ref` schemas; duplicated inline objects drift apart over time.
- Match the OpenAPI version already in the file; 3.1 uses JSON Schema `type` arrays for nullable, 3.0 uses `nullable: true`.
- Lint before committing; an invalid spec breaks downstream codegen and mock servers.
