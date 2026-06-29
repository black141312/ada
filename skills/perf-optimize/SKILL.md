---
name: perf-optimize
description: Optimize a measured hot path — profile first, fix the real bottleneck, prove the speedup
category: performance
---

# Perf Optimize

Reach for this when something is measurably slow and you need to speed it up without guessing.

1. Reproduce the slow path with a stable, repeatable benchmark or input and record a baseline number (wall time, p95, throughput).
2. Profile it (sampling/CPU profiler, `perf`, flamegraph, language profiler) to find where time actually goes — never optimize from intuition.
3. Confirm the top one or two hotspots account for most of the cost; ignore the long tail of cheap functions.
4. Apply the smallest change that attacks the dominant cost: better algorithm/complexity, fewer allocations, avoid redundant work, or move work out of the loop.
5. Re-run the same benchmark and compare against baseline; keep the change only if the win is real and worth the complexity.
6. Add a regression guard (benchmark in CI or a perf assertion) so the gain doesn't silently erode.

## Rules
- Measure before and after with the same inputs and a warm/steady state — one cold run is noise.
- Optimize the actual bottleneck the profiler shows, not the code that "looks slow".
- Algorithmic wins (O(n^2) -> O(n log n)) beat micro-optimizations; check complexity before tuning constants.
- Don't sacrifice correctness or readability for a speedup you can't measure.
- State the numbers in the result: "X ms -> Y ms (Nx)" so the win is auditable.
