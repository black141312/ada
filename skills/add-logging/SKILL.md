---
name: add-logging
description: Add strategic temporary logging to isolate an issue, read the output, then remove it cleanly
category: debugging
---

# Add Logging

Reach for this when you can't see what the code is doing and a debugger isn't practical (async flows, production-like runs, fast loops). Logging buys visibility — but it's scaffolding, not a deliverable.

1. Decide what you need to confirm: which branch was taken, what a value is, whether a function ran, or how long something took.
2. Place logs at decision points and boundaries — function entry/exit, before/after the suspect call, inside each branch of the `if`.
3. Log identifying context with each value: a label, the variable name, and a correlation id if multiple requests interleave.
4. Run the repro, read the output, and narrow: each pass should let you delete some logs and add more around the surviving suspect.
5. Once the root cause is confirmed, apply the fix.
6. Remove every temporary log (grep for your unique marker), and re-run to confirm the fix holds without them.

## Rules
- Tag temporary logs with a unique searchable string (e.g. `XDEBUG`) so you can find and delete all of them.
- Log values, not just "got here" — `console.log('count', count)` beats `console.log('here')`.
- For loops or hot paths, gate logging or log only the boundary case so output stays readable.
- Don't commit debug logs; if a log is genuinely worth keeping, promote it to a real logger at the right level deliberately.
- Beware that logging can mask timing bugs — see the heisenbug skill if the bug vanishes once logs are added.
