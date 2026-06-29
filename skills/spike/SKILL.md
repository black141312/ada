---
name: spike
description: Run a timeboxed exploration of an unknown and write up findings, a recommendation, and next steps
category: productivity
---

# Spike

Use this when a task is too uncertain to estimate or plan — you need to learn something (a library, an API, a feasibility question) within a fixed time budget and report back, not ship production code.

1. State the question the spike must answer and the timebox (e.g. "Can we stream this API's responses? — 60 min") before touching anything.
2. List 2-4 concrete things to try or check, ordered cheapest-to-prove-first.
3. Explore: prototype throwaway code, read docs/source, run experiments — keep notes on what you tried and what happened.
4. Stop when the timebox ends OR the question is answered, whichever comes first; do not let scope creep into building the real thing.
5. Write up findings: the answer, the evidence behind it, surprises/risks discovered, and a clear recommendation (do it / don't / need another spike).
6. List the follow-up tasks the spike unblocked, and explicitly mark prototype code as throwaway.

## Rules
- Honor the timebox — a spike that runs long has failed its own purpose; report partial findings instead.
- Optimize for learning, not quality: no tests, no polish, no refactors on spike code.
- Always end with a decision or recommendation; "it's complicated" is not an output.
- Keep prototype code on a scratch branch or clearly labeled dir so it never merges by accident.
- If you cannot answer within the box, say so and propose a narrower follow-up spike.
