---
name: fix-flaky-tests
description: Diagnose an intermittent failure — a flaky test or a race in real code — and remove the nondeterminism behind it
category: testing
---

# Fix Flaky Tests

Use when something fails only sometimes — a test that passes and fails without code changes, or a race in real code that vanishes the moment you add a log or a breakpoint. Both are timing and shared-state bugs; treat them differently from deterministic ones.

1. Reproduce the flake: run the test in a loop (e.g. 50-100x) and run it both isolated and within the full suite.
2. Capture failing output and compare it to passing runs to pinpoint what varies between them.
3. Classify the cause: timing/async races, test-order or shared-state leakage, unmocked clock/random/network, or resource contention. Suspect the usual sources — missing await/synchronization, check-then-act races, unprotected shared variables, reliance on iteration/map order, wall-clock timing.
4. Make the race MORE likely, not less: add jitter, raise concurrency, randomize scheduling, shrink timeouts — so it fails almost every run and you can see it.
5. Fix the root cause — await real conditions instead of sleeping, isolate or reset shared state, inject the clock/seed, stub the network.
6. Re-run the loop (100x+) to confirm the flake is gone, not just hidden behind a longer timeout.
7. If you cannot fix it now, quarantine it explicitly with a tracked issue rather than leaving it to randomly red the CI.

## Rules
- Never "fix" a flake by bumping a sleep or adding a blind retry — that masks the race, not removes it.
- Replace fixed delays with polling on the actual condition (element present, value settled, job done).
- Suspect order-dependence: run the suite shuffled and in reverse to surface state leakage between tests.
- Pin nondeterministic inputs — freeze time, seed RNG, fix timezone/locale — rather than asserting loosely.
- A test you quarantine must have an owner and a tracking issue; quarantine is a pause, not a fix.
- A "fix" that only lowers the failure rate is not a fix — a real one makes the failure impossible, not rare.
- Adding a log or debugger changes timing and can hide the bug; prefer post-hoc capture (record, then inspect) over live stepping.
- Reproduce on the same concurrency/hardware profile as production — single-core or low-load runs may never trigger it.
