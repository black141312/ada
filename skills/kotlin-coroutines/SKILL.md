---
name: kotlin-coroutines
description: Refactor Kotlin callback and threaded code into coroutines with structured concurrency
category: languages
---

# Kotlin Coroutines

Use this when replacing callback hell, `Thread`/`Executor` code, or RxJava chains with `suspend` functions and structured concurrency.

1. Identify the async boundaries: callbacks, futures, `Thread`, or blocking calls — these become `suspend` functions or `withContext` blocks.
2. Convert callback APIs with `suspendCancellableCoroutine`, resuming on success/failure and wiring `invokeOnCancellation` to release the underlying resource.
3. Mark functions that suspend as `suspend fun`, and run blocking work on the right dispatcher (`withContext(Dispatchers.IO)` for I/O, `Default` for CPU).
4. Launch concurrent work inside a scope (`coroutineScope { ... }` or a lifecycle-bound scope), using `async`/`await` for parallel results and `launch` for fire-and-forget within that scope.
5. Replace streams of callbacks with `Flow` (`callbackFlow` for callback sources), and collect them in a scope that respects lifecycle.
6. Verify cancellation and exceptions propagate: test that cancelling the scope stops the work, and that failures surface rather than being swallowed.

## Rules
- Never use `GlobalScope`; tie coroutines to a structured scope (`viewModelScope`, `coroutineScope`, or an explicit `CoroutineScope` you cancel) so they're cancelled with their owner.
- Switch dispatchers with `withContext`, not by launching new coroutines, and never block a coroutine thread with `Thread.sleep` or blocking I/O on `Default`/`Main`.
- Suspending functions must be main-safe — a `suspend fun` should be callable from any dispatcher and move blocking work off it internally.
- Make cancellation cooperative: check `isActive`/`ensureActive()` in loops, and don't swallow `CancellationException` — rethrow it.
- Prefer `coroutineScope`/`supervisorScope` over manual `Job` juggling; choose `supervisorScope` only when one child's failure should not cancel its siblings.
