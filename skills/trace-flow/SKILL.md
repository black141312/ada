---
name: trace-flow
description: Trace a request or data flow end-to-end across layers, from entry point to final effect
category: code-understanding
---

# Trace Flow

Use to follow a single request, event, or piece of data through the system — e.g. "what happens when a user submits this form?" — across the layers it touches.

1. Find the entry point: the route, handler, listener, CLI command, or subscriber where the flow begins.
2. Step forward through each call, recording the file, function, and what transforms the data at that hop.
3. Cross boundaries deliberately: middleware, service calls, queues, DB reads/writes, external APIs, and async/await or callback handoffs.
4. Track the data shape as it changes — note where it is validated, mapped, enriched, or persisted.
5. Identify the terminal effect: the response returned, row written, message published, or file emitted.
6. Lay out the path as an ordered list of hops with file:line, and mark branch points, retries, and error/rollback paths.

## Rules
- Async boundaries break the call stack — connect producers to consumers by the queue/topic/event name, not by control flow.
- Note where the flow forks (conditionals, fan-out) instead of silently following one branch.
- Call out side effects along the way (logging, caching, metrics) separately from the main data path.
- If a hop dispatches dynamically and you cannot resolve the target, say so rather than guessing.
- Anchor every hop to a concrete file:line so the reader can follow along.
