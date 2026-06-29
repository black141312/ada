---
name: repro
description: Build a minimal, reliable reproduction of a bug before attempting to fix it
category: debugging
---

# Repro

Use when a bug is reported vaguely or only happens "sometimes." A minimal repro turns a fuzzy report into a concrete, debuggable artifact — and often reveals the cause by itself.

1. Capture the original conditions: inputs, environment, versions, and the exact observed failure.
2. Get it failing once on your machine, however ugly — full app, real data, whatever it takes.
3. Strip it down: remove unrelated code, mock external services, shrink the input toward the smallest case that still fails.
4. Pin nondeterminism — fix random seeds, freeze clocks, force single-threaded, hardcode the offending input — until it fails every run.
5. Turn it into a runnable script or a failing test that anyone can execute with one command.
6. Confirm the repro fails for the right reason (same error/trace), not a new unrelated one.

## Rules
- A repro you can't run on demand isn't done — "it happened in prod once" is a lead, not a repro.
- Remove things one at a time; if the failure disappears, you just found a clue about the cause.
- Keep the input as small as possible — a 3-line case beats a 300-line dump for finding the bug.
- Prefer a failing test over a throwaway script so the repro stays as a regression guard after the fix.
- If you genuinely can't reproduce, add logging in the real environment to capture the conditions next time it fires.
