---
name: debug
description: Apply a systematic debugging procedure — reproduce, isolate, fix, verify — instead of guessing at fixes
category: debugging
---

# Debug

Reach for this when something is broken or behaving unexpectedly and you're tempted to start changing code. Slow down and follow the loop so the fix is real, not a coincidence.

1. State the bug precisely: what you expected, what actually happened, and the exact error or wrong output.
2. Reproduce it reliably — get a single command or steps that fail every time. If you can't reproduce it, you can't fix it.
3. Form one hypothesis about the cause and predict what you'd observe if it were true.
4. Isolate: bisect the input, the code path, or git history (`git bisect`) until the failure is localized to a few lines.
5. Confirm the root cause by observation (a log, a breakpoint, a value) — not by assumption.
6. Apply the smallest fix that addresses the cause, then re-run the repro to confirm it now passes.
7. Add or adjust a test that would have caught this, and check nearby code for the same mistake.

## Rules
- Change one thing at a time; if you change three, you won't know which fixed it.
- Fix the cause, not the symptom — suppressing an error or adding a null guard at the crash site is rarely the real fix.
- Never claim it's fixed without re-running the exact reproduction that failed.
- If a hypothesis is disproven, discard it and write a new one — don't keep patching a dead theory.
- Keep a running note of what you ruled out so you don't loop back over it.
