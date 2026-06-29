---
name: perf-profile
description: Profile code to find the actual hot path before optimizing, then verify the speedup with numbers
category: debugging
---

# Perf Profile

Use when something is slow and you need to know *where* the time goes before touching code. Intuition about bottlenecks is usually wrong — measure first, optimize the proven hot path, measure again.

1. Establish a baseline: a repeatable workload and a number (wall time, p95 latency, throughput) you can compare against.
2. Run a profiler (CPU sampling, or a flame graph) under that workload — don't guess from reading the code.
3. Read the profile for the hot path: the functions with the highest self time (their own work) vs cumulative time (work below them).
4. Identify the dominant cost — tight CPU loop, repeated allocation, N+1 queries, blocking I/O, lock contention, or serialization.
5. Apply one targeted optimization (algorithmic win, caching, batching, removing redundant work) and re-profile.
6. Compare against the baseline number to confirm a real improvement, and check you didn't regress correctness.

## Rules
- Optimize self time, not cumulative time — a function high in cumulative time may just be calling the real culprit.
- Profile a realistic workload; microbenchmarks lie about cache, allocation, and I/O behavior.
- A better algorithm (O(n²)→O(n)) usually beats micro-optimizing the inner loop — check complexity first.
- Don't optimize anything the profile doesn't flag; premature tuning adds complexity for no measured gain.
- Warm up the runtime (JIT, caches) before measuring, and run enough iterations to beat noise.
