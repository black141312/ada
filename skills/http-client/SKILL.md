---
name: http-client
description: Build a robust HTTP client with timeouts, bounded retries, backoff, and connection reuse
category: networking
---

# HTTP Client

Use whenever code calls an external HTTP API and must survive flaky networks and slow upstreams. A naive `fetch`/`get` with no timeout is a production incident waiting to happen.

1. Set explicit timeouts on every request — connect, read/idle, and a total deadline — so a hung server can't pin a thread or goroutine forever.
2. Reuse one client/connection pool instance across calls (keep-alive); creating a client per request exhausts sockets.
3. Retry only idempotent, transient failures (connection errors, 429, 5xx) with exponential backoff + jitter and a hard cap on attempts.
4. Honor `Retry-After` on 429/503; respect server-provided backoff over your own schedule.
5. Add a circuit breaker or failure budget so a dead dependency fails fast instead of amplifying load with retries.
6. Propagate cancellation (context/`AbortSignal`), set a descriptive `User-Agent`, and check status codes explicitly — don't assume 2xx.

## Rules
- Never retry non-idempotent requests (`POST` without an idempotency key) — you'll double-charge, double-send, double-create.
- Add jitter to backoff; synchronized retries from many clients cause thundering-herd retry storms.
- Always cap total retries and total elapsed time; unbounded retry loops turn a blip into an outage.
- Read and close response bodies even on errors, or you leak connections from the pool.
- Don't log full request/response bodies or auth headers by default — redact secrets.
