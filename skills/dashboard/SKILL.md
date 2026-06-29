---
name: dashboard
description: Build a Grafana/observability dashboard organized around the four golden signals
category: observability
---

# Dashboard

Reach for this when you need an at-a-glance view of service health for triage during an incident or a daily glance.

1. Decide the audience and scope (one service, one team, or fleet) and template it with variables (`$env`, `$service`, `$instance`) so one dashboard serves many targets.
2. Lead with the four golden signals — traffic, errors, latency (p50/p95/p99), saturation — in the top row as the triage summary.
3. Build panels from the queries that already back your alerts (rate, error ratio, latency histograms) so the dashboard and alerts agree.
4. Order top-to-bottom from symptoms to causes: user-facing SLIs first, then dependencies (DB, queues, downstream), then resources (CPU, memory, connections).
5. Set units, sane axis mins (0), and thresholds/annotations (deploys, incidents) so spikes are readable in context.
6. Export the dashboard JSON and commit it to the repo so it's version-controlled and reproducible, not hand-edited in the UI.

## Rules
- Keep it scannable — a dozen focused panels beat fifty; split deep-dives into linked dashboards.
- Use rate() over counters and quantiles over histograms; never plot raw counter totals.
- Make latency panels show percentiles, not just averages — averages hide tail pain.
- Template, don't duplicate: variables over per-host copies.
- Store dashboards as code (JSON/Jsonnet/Terraform) and review changes in PRs.
