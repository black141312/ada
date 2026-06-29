---
name: structured-logging
description: Adopt structured, leveled JSON logging with consistent fields and correlation IDs
category: observability
---

# Structured Logging

Reach for this when grep-on-plaintext logs stop scaling — you need to filter, aggregate, and correlate logs in a log backend.

1. Pick a structured logger (pino, zap, structlog, slog) and configure JSON output to stdout; let the platform handle shipping.
2. Define a base logger with always-present fields: `service`, `env`, `version`, and a `level`.
3. Bind request-scoped context (`request_id`, `trace_id`, `user_id` if non-PII) via child loggers / context so every line in a request shares correlation keys.
4. Use levels deliberately: `error` for actionable failures, `warn` for recoverable anomalies, `info` for lifecycle events, `debug` for diagnostics off by default in prod.
5. Log events as `message` + structured fields, never string-concatenated values (`log.info('order placed', { order_id, amount })`).
6. Set log level from an env var and confirm JSON parses and correlation IDs thread through a sample request.

## Rules
- Never log secrets, tokens, passwords, full card/PII; add a redaction list and apply it at the logger, not per call site.
- One event per log line; don't split a single event across multiple lines.
- Reuse field names consistently across the codebase (`user_id` everywhere, not `userId`/`uid`).
- Don't log inside hot loops at `info`; guard expensive payloads behind level checks.
- Include `trace_id` so logs join traces; emit it from the same context source.
