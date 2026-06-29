---
name: py-async
description: Convert blocking Python code to async/await without deadlocks or hidden sync calls
category: languages
---

# Py Async

Use this when a module's I/O latency dominates and you want to move it to `asyncio`, or when porting sync callers into an existing async stack.

1. Map the blocking boundaries: identify every network, disk, subprocess, and `time.sleep` call — these become `await` points or run in an executor.
2. Swap sync libraries for async equivalents (`requests`→`httpx`/`aiohttp`, `psycopg2`→`asyncpg`, `open`→`aiofiles`) rather than wrapping everything in threads.
3. Convert functions to `async def` from the I/O leaves upward, propagating `await` to every caller until you reach an entry point.
4. For unavoidable blocking calls (CPU work, sync-only libs), offload with `await asyncio.to_thread(fn, ...)` or a process pool — don't call them directly on the loop.
5. Replace sequential awaits with `asyncio.gather` or `TaskGroup` where operations are independent, and guard shared state with `asyncio.Lock`.
6. Run under load and check for "coroutine was never awaited" warnings, blocked-loop stalls, and unhandled task exceptions.

## Rules
- Never call a blocking function directly inside a coroutine — it stalls the entire event loop for all tasks.
- One event loop per process: use `asyncio.run(main())` at the top; don't create nested loops or call `loop.run_until_complete` from within async code.
- Cancellation is cooperative — propagate `CancelledError`, and put cleanup in `finally` or `async with`.
- Set timeouts on every await that hits the network (`asyncio.timeout(...)`); an unbounded await is a hang waiting to happen.
- Don't mix sync and async versions of the same function in one call graph — pick a color and commit to it.
