---
name: stacktrace
description: Read a stack trace and locate the root cause frame instead of fixing where the error surfaced
category: debugging
---

# Stacktrace

Use when you have an exception, panic, or crash trace and need to find what actually went wrong. The top of the trace is where it blew up, not always where the bug lives.

1. Read the exception type and message first — they often tell you the category (null/undefined, type mismatch, index, IO, timeout).
2. Find the deepest frame that belongs to your code (skip framework/library frames) — that's usually where to start looking.
3. Identify the exact line and the values involved: which variable was null, which index was out of range, which call failed.
4. Walk up the trace to see how that bad value got there — trace the argument back to its origin (caller, config, input, prior call).
5. Reproduce the failing call in isolation if possible, or add a log just above the failing line to inspect the inputs.
6. Fix at the origin of the bad value, not merely at the line that threw.

## Rules
- "Caused by" / chained exceptions matter most — read to the bottom of the chain for the original failure.
- Async/promise traces can be truncated or misleading; enable async stack traces or long-stack support when frames look orphaned.
- A line number can drift if the source was transpiled/minified — map back through source maps before trusting it.
- Don't wrap the throw site in try/catch to make the trace disappear; that hides the bug.
- If the trace is all library frames, the trigger is almost always the data or arguments you passed in.
