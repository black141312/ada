---
name: tracing
description: Add distributed tracing spans with OpenTelemetry to follow requests across services
category: observability
---

# Tracing

Use this when a request crosses service or async boundaries and you need to see where time goes and how calls fan out.

1. Install the OpenTelemetry SDK plus auto-instrumentations for your HTTP/DB/queue libraries, and configure an OTLP exporter to your collector or backend (Jaeger, Tempo, Honeycomb).
2. Set a `service.name` resource attribute and a sampler (parent-based, with a ratio for high-traffic services) in the tracer provider.
3. Enable auto-instrumentation first — it covers inbound/outbound HTTP, DB clients, and frameworks for free; verify spans appear before adding manual ones.
4. Add manual spans only around meaningful units of work the libraries don't cover (business logic, batch steps), naming them `verb.noun` (`charge.card`).
5. Attach attributes for high-signal context (`tenant.id`, `job.kind`, row counts) and record exceptions with `span.recordException` + set status `ERROR`.
6. Ensure W3C `traceparent` propagation across service calls and into async work (queues, background jobs) so traces stay connected; verify an end-to-end trace links all hops.

## Rules
- One trace per logical request; don't start a new root span mid-request — continue the propagated context.
- Keep span names low-cardinality (no IDs in the name — put IDs in attributes).
- Always `end()` spans, including on error paths; use a try/finally or scoped helper.
- Sample at the head consistently across services so traces aren't half-recorded.
- Never put secrets, full request bodies, or PII in span attributes.
