---
name: mock-api
description: Stub or mock external services in tests so they run fast, offline, and deterministically
category: testing
---

# Mock API

Use when a test depends on an external service (HTTP API, third-party SDK) and you need it isolated and deterministic.

1. Identify the boundary to mock — the HTTP call or client method — and intercept at that seam, not deep inside your logic.
2. Choose the level: network-level interception (e.g. nock/MSW) for HTTP, or dependency injection/stubbing for client objects.
3. Define realistic responses for the cases under test: success payload, the error/4xx/5xx paths, and timeouts.
4. Wire the mock in setup and assert the request was made as expected (URL, method, body, headers) where it matters.
5. Reset or restore mocks between tests so stubs don't leak across cases.
6. Keep one real integration/contract test (or recorded fixture check) so the mock can't silently drift from the real API.

## Rules
- Mock at the network or client boundary, never by monkey-patching your own business logic.
- Base mock payloads on the real API's actual shape; an invented response that the real service never returns tests nothing.
- Always cover failure modes — non-2xx, malformed body, timeout — not just the happy response.
- Restore/reset all mocks in teardown so global state doesn't bleed between tests.
- Guard against drift with a contract or recorded-fixture test against the real service, run less often if needed.
