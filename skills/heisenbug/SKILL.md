---
name: heisenbug
description: Debug intermittent timing and concurrency bugs that vanish under observation
category: debugging
---

# Heisenbug

Use when a bug appears only sometimes — flaky tests, race conditions, ordering-dependent failures — and disappears the moment you add a log or a breakpoint. These are timing and shared-state bugs; treat them differently from deterministic ones.

1. Quantify the flakiness: loop the failing case hundreds of times to get a failure rate you can track as you investigate.
2. Hunt for shared mutable state crossing threads/tasks/processes, and for any code that assumes an order events don't guarantee.
3. Suspect the usual sources: missing await/synchronization, check-then-act races, unprotected shared variables, reliance on iteration/map order, or wall-clock timing.
4. Make the race more likely instead of less — add jitter/delays, increase concurrency, randomize scheduling, shrink timeouts — so it fails almost every run.
5. Once it fails reliably, fix the cause: add proper locking/atomics, await the dependency, make the operation idempotent, or remove the shared state.
6. Verify by running the original loop thousands of times with zero failures, then remove any artificial delays you added.

## Rules
- Adding a log or debugger changes timing and can hide the bug — prefer post-hoc capture (record then inspect) over live stepping.
- A "fix" that just lowers the failure rate is not a fix; a real fix makes it impossible, not rare.
- Don't paper over flakiness with retries or longer sleeps — that hides a race that will resurface under load.
- Set a fixed seed for anything random so a failing run is reproducible.
- Reproduce on the same concurrency/hardware profile as production; single-core or low-load runs may never trigger it.
