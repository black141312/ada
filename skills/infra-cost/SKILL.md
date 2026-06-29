---
name: infra-cost
description: Estimate cloud spend and trim it without degrading reliability
category: cloud
---

# Infra Cost

Use this to put a number on what infrastructure costs (before or after deploy) and to find the cuts that save the most money for the least risk.

1. Pull the actual bill broken down by service and tag (Cost Explorer / billing export) to see where money actually goes.
2. For planned changes, estimate with a pricing tool (`infracost breakdown` on Terraform, or the provider calculator) before merging.
3. Rank line items by spend and target the top few — compute, egress, and idle/oversized resources are usually the bulk.
4. Right-size: match instance/DB sizes to observed utilization, delete unattached volumes/IPs/snapshots, and stop non-prod overnight.
5. Commit to discounts where usage is stable (savings plans / reserved / committed-use); use spot/preemptible for fault-tolerant batch work.
6. Cut data-transfer cost by keeping traffic in-region/in-AZ and fronting egress with a CDN.
7. Add billing alerts/budgets and a `cost` tag so regressions are caught early.

## Rules
- Measure before cutting — right-size from real utilization metrics, not guesses, to avoid causing incidents.
- Egress is often the silent top cost; check cross-AZ, cross-region, and internet-egress traffic specifically.
- Reserved/committed pricing only pays off for steady baseline load — don't commit to spiky or shrinking workloads.
- Tag resources for cost allocation; untagged spend is unaccountable and the first place waste hides.
- Don't sacrifice redundancy (multi-AZ, backups) for marginal savings — a single outage can dwarf the cut.
