---
name: postmortem
description: Write a blameless incident postmortem with timeline, root cause, and preventive action items
category: productivity
---

# Postmortem

Reach for this after an incident, outage, or serious bug to produce a blameless write-up that explains what happened and prevents a recurrence — focused on the system that allowed the failure, never on who pushed the button.

1. Write a one-paragraph summary: what broke, who/what was affected, the user-visible impact, and the duration.
2. Build a timeline from evidence — deploy logs, alerts, chat, commits — with timestamps from first symptom through detection, mitigation, and full resolution.
3. Find the root cause by asking "why" past the trigger until you reach a systemic gap (missing test, absent alert, unguarded assumption), not a person.
4. Separate the trigger (what set it off) from the root cause (why it could happen at all) and from the impact.
5. Capture detection and response: how long to notice, how long to mitigate, and what made each faster or slower.
6. List preventive action items — each with an owner and due date — covering prevention, faster detection, and quicker mitigation.

## Rules
- Blameless, always: "the deploy lacked a rollback step", never "X forgot to roll back".
- Anchor the timeline in real timestamps and sources; reconstruct from logs, do not guess.
- Distinguish trigger vs root cause vs impact — conflating them produces shallow fixes.
- Every action item gets an owner and date; track them to closure or they were theater.
- Capture time-to-detect and time-to-mitigate explicitly — they are often the biggest lever for the next incident.
- Write it while memory is fresh; a postmortem a week late loses the detail that matters.
