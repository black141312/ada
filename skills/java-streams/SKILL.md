---
name: java-streams
description: Modernize imperative Java loops into Streams and replace null checks with Optional
category: languages
---

# Java Streams

Use this when refactoring verbose loop-and-accumulate Java into the Streams API, or replacing null-juggling with `Optional`, without changing behavior.

1. Spot the loop shape: filter/map/reduce/collect patterns over a collection are the prime candidates; a loop with side effects or early break may be clearer left as-is.
2. Translate the pipeline: `for` + `if` + `add` becomes `stream().filter(...).map(...).collect(toList())`; sums/counts become `mapToInt(...).sum()` or `collect(counting())`.
3. Replace grouping/partitioning loops with `Collectors.groupingBy` / `toMap` / `partitioningBy` instead of manually populating maps.
4. Convert methods that may return null to `Optional<T>`, and consume them with `map`/`filter`/`orElseGet`/`ifPresent` rather than `.get()` after an `isPresent` check.
5. Keep lambdas small and side-effect-free; extract complex bodies to named methods or method references (`Type::method`) for readability.
6. Run the existing test suite and confirm output equality, ordering, and null behavior are unchanged.

## Rules
- Streams are for transformation, not iteration with side effects — don't mutate external state inside `forEach`; use `collect` to build results.
- Never call `Optional.get()` without a guarantee; prefer `orElse`, `orElseThrow`, or `ifPresentOrElse`. Don't use `Optional` for fields or method parameters.
- Watch performance: a stream over a tiny list can be slower and noisier than a plain loop — don't convert for its own sake.
- Preserve ordering semantics; `Collectors.toMap` throws on duplicate keys and `groupingBy` returns a `HashMap` (unordered) unless you supply a map factory.
- Avoid stateful or order-dependent lambdas in parallel streams — they'll race; default to sequential unless you've proven a parallel win.
