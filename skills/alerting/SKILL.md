---
name: alerting
description: Define actionable alerts and SLOs that page on symptoms, not noisy causes
category: observability
---

# Alerting

Use this to turn metrics into alerts that wake someone only when users are actually affected — and to back them with SLOs.

1. Define the SLO first: pick a user-facing SLI (availability or latency), a target (e.g. 99.9% over 30 days), and compute the error budget.
2. Alert on symptoms (elevated error rate, p99 latency, budget burn) rather than causes (high CPU) — page on what users feel.
3. Use multi-window burn-rate alerts: a fast window (e.g. 5m) and a slow window (e.g. 1h) both breaching, so you page on sustained burn, not single spikes.
4. Set `for:` durations to require the condition to persist, suppressing flaps; add `severity` labels routing critical→page, warning→ticket.
5. Write a runbook link and a clear, templated summary into each alert annotation so the on-call knows what broke and what to do.
6. Test by injecting a failure or backfilling data, confirm the alert fires, routes, and resolves; tune thresholds against historical data to bound false positives.

## Rules
- Every alert must be actionable — if there's no human response, make it a dashboard, not a page.
- Page on customer impact; ticket or silence everything else.
- Tie thresholds to the error budget, not arbitrary round numbers.
- Always include a runbook URL and the affected service/component in annotations.
- Add an "absent data" alert so a dead exporter doesn't silently hide outages.
