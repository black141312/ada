---
name: add-metrics
description: Instrument code with Prometheus/OpenTelemetry metrics for counters, gauges, histograms
category: observability
---

# Add Metrics

Reach for this when you need to measure rates, throughput, latency, or resource levels — request counts, error rates, queue depth, job durations.

1. Pick the client matching the stack (prom-client for Node, prometheus-client for Python, OTel SDK for vendor-neutral) and add it as a dependency.
2. Choose the right instrument per signal: counter for monotonic totals (requests, errors), gauge for point-in-time values (in-flight, queue size), histogram for distributions (latency, payload size).
3. Define metrics once at module scope with a stable `name`, `help` text, and low-cardinality labels; never recreate them per request.
4. Increment/observe at the call site — wrap handlers or middleware so every request records duration and outcome (`status`, `route`).
5. Expose a `/metrics` endpoint (Prometheus) or wire an OTLP exporter (OpenTelemetry) and confirm it scrapes with `curl localhost:PORT/metrics`.
6. Add a histogram for the critical path latency using sensible buckets (e.g. `0.005..10` seconds) rather than the defaults.

## Rules
- Keep label cardinality bounded — never put user IDs, request IDs, emails, or raw URLs in labels; normalize routes to templates (`/users/:id`).
- Use base units and suffixes Prometheus expects: seconds (not ms), bytes, `_total` for counters, `_seconds` for durations.
- Initialize counters to 0 for all known label sets so absence vs. zero is distinguishable.
- Record duration in a `finally` block so errors still get measured.
- Don't block the request path on metric export; exporters must be async/buffered.
