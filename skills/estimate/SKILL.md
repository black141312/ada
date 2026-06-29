---
name: estimate
description: Break a task into estimated subtasks with assumptions, dependencies, and a total range
category: productivity
---

# Estimate

Reach for this when someone asks "how long will this take?" — turn a vague task into a decomposed, defensible estimate with the uncertainty made explicit instead of a single hopeful number.

1. Clarify the scope and the definition of done; note anything ambiguous as an explicit assumption you are estimating against.
2. Decompose the task into subtasks small enough that each is obvious in size (roughly a half-day or less); split anything you can't size.
3. For each subtask give a three-point estimate — optimistic / likely / pessimistic — and a one-line reason for the spread.
4. Mark dependencies and ordering between subtasks, plus any external blockers (reviews, access, third-party APIs).
5. Add explicit line items for testing, code review, and integration — the work that estimates usually forget.
6. Total the likely column for a point estimate and the optimistic-to-pessimistic span for a range; flag the riskiest 1-2 subtasks driving the spread.

## Rules
- Never give a single bare number — always a range, and always with the assumptions it rests on.
- Estimate effort, not calendar time; do not bake in meetings, context-switching, or someone's availability.
- If a subtask's pessimistic case is more than ~3x its optimistic, it's underspecified — split it or spike it first.
- Don't pad silently; if you add buffer, label it as buffer so it can be challenged.
- Re-estimate when scope or assumptions change rather than defending a stale number.
