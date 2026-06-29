---
name: error-tracking
description: Wire up Sentry/error reporting with context, releases, and source maps
category: observability
---

# Error Tracking

Use this when uncaught exceptions and crashes need to be captured, grouped, and triaged with enough context to fix them.

1. Add the SDK (Sentry or equivalent) and initialize it as early as possible in startup with the DSN from an env var and the `environment` set.
2. Set `release` to the build SHA/version and upload source maps (or debug symbols) in CI so stack traces de-minify to real source lines.
3. Let the SDK install global handlers for uncaught exceptions and unhandled rejections; add framework middleware so request errors are captured automatically.
4. Enrich events with context — user (non-PII id), tags (`route`, `tenant`), and breadcrumbs — and scrub sensitive fields with `beforeSend`.
5. Tune sampling: capture 100% of errors but sample performance/traces; set rate limits so a storm doesn't blow your quota.
6. Trigger a test error post-deploy, confirm it lands grouped with a readable stack trace and correct release, then wire alerts/ownership for new issues.

## Rules
- Scrub PII and secrets in `beforeSend` — request bodies, headers, tokens, emails.
- Always set `release` + upload source maps, or stack traces are useless.
- Don't capture expected/handled control-flow errors (validation, 404s) — filter them to cut noise.
- Link error events to `trace_id` so you can pivot to traces and logs.
- Fail open: SDK init or transport errors must never crash the app.
