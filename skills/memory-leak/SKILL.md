---
name: memory-leak
description: Find and fix a memory leak by measuring growth, capturing heaps, and tracing retained references
category: debugging
---

# Memory Leak

Use when memory climbs over time and doesn't come back down — RSS growth, OOM kills, GC thrashing, or a process that gets slower the longer it runs. The goal is to find what's still being referenced after it should be free.

1. Confirm it's a real leak: drive a repeating workload and watch memory across cycles — a leak grows monotonically and never returns to baseline after GC.
2. Take a heap snapshot at a steady state, run more cycles, take another, and diff them to see which object types grew.
3. Pick the growing type and inspect its retainer/retention path — find what's holding the reference that should have been released.
4. Trace that reference to the code: usually an unbounded cache/array, an event listener never removed, a closure capturing large state, or a timer never cleared.
5. Break the retention — remove the listener, bound or evict the cache, clear the timer, drop the closure capture — and re-run the cycle test.
6. Verify memory now returns to baseline across many cycles and stays flat under sustained load.

## Rules
- Force/allow GC before measuring, or you'll chase garbage that just hadn't been collected yet.
- Compare snapshots at the same point in the cycle — drift in workload looks like a leak when it isn't.
- The biggest object isn't the leak; the one that keeps growing across snapshots is.
- Common culprits: event emitters, global/module-level collections, caches without eviction, subscriptions, and detached DOM nodes.
- Fix retention, then prove it with a long soak run — a single short run won't show a slow leak.
