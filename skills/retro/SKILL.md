---
name: retro
description: Write a sprint or project retrospective that turns observations into committed action items
category: productivity
---

# Retro

Use this at the end of a sprint, milestone, or project to capture what happened and convert it into concrete changes — a retro without owned action items is just venting.

1. Set the window and gather inputs: the goals for the period, what shipped, plus signals from git log, merged PRs, closed issues, and CI history.
2. Sort observations into three buckets: what went well (keep), what went poorly (stop), and what to try (start).
3. For each "went poorly" item, dig one level past the symptom to a plausible cause rather than restating the complaint.
4. Pull the highest-leverage themes — focus on the few that recur or hurt most, not an exhaustive list.
5. Convert each theme into an action item with a clear owner, a concrete next step, and a check-back date.
6. Write it up: a short summary, the keep/stop/start lists, and a table of action items (action, owner, due).

## Rules
- Keep it blameless — describe systems and decisions, not individuals' failures.
- Every "went poorly" should map to at least one action item or an explicit "accept and move on".
- Action items need an owner and a date; "the team should" with no owner is not an action item.
- Ground claims in evidence (PRs, incidents, metrics) instead of vibes where you can.
- Cap it: 3-5 action items the team will actually do beats 20 that get ignored.
