---
name: fix-flaky-tests
description: Diagnose an intermittently failing test and stabilize it by removing the source of nondeterminism
category: testing
---

# Fix Flaky Tests

Use when a test passes and fails without code changes, eroding trust in the suite.

1. Reproduce the flake: run the test in a loop (e.g. 50-100x) and run it both isolated and within the full suite.
2. Capture failing output and compare it to passing runs to pinpoint what varies between them.
3. Classify the cause: timing/async races, test-order or shared-state leakage, unmocked clock/random/network, or resource contention.
4. Fix the root cause — await real conditions instead of sleeping, isolate or reset shared state, inject the clock/seed, stub the network.
5. Re-run the loop (100x+) to confirm the flake is gone, not just hidden behind a longer timeout.
6. If you cannot fix it now, quarantine it explicitly with a tracked issue rather than leaving it to randomly red the CI.

## Rules
- Never "fix" a flake by bumping a sleep or adding a blind retry — that masks the race, not removes it.
- Replace fixed delays with polling on the actual condition (element present, value settled, job done).
- Suspect order-dependence: run the suite shuffled and in reverse to surface state leakage between tests.
- Pin nondeterministic inputs — freeze time, seed RNG, fix timezone/locale — rather than asserting loosely.
- A test you quarantine must have an owner and a tracking issue; quarantine is a pause, not a fix.
