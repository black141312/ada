---
name: game-loop
description: Set up a fixed-timestep game loop with decoupled update and render
category: gamedev
---

# Game Loop

Reach for this when frame-rate-independent simulation matters: physics, networking, or deterministic gameplay that must behave the same at 30 and 144 fps.

1. Pick a fixed simulation step (e.g. `dt = 1/60`) for update; keep rendering uncapped or vsync-bound separately.
2. Each frame, measure real elapsed time and add it to an accumulator: `accumulator += frameTime`.
3. Run `while (accumulator >= dt) { update(dt); accumulator -= dt; }` so simulation advances in fixed chunks.
4. Compute interpolation alpha = `accumulator / dt` and render between previous and current state to avoid stutter.
5. Clamp `frameTime` to a max (e.g. 0.25s) before accumulating to prevent the "spiral of death" after a stall.
6. Keep input sampling at the top of the frame; apply input inside `update`, not render.

## Rules
- Never pass a variable wall-clock delta into physics — that breaks determinism and collision.
- Cap accumulated time so a debugger pause or GC stall does not trigger hundreds of catch-up updates.
- Store previous and current state explicitly so render interpolation has both endpoints.
- Use a monotonic clock (`performance.now`, `std::chrono::steady_clock`), never system wall time.
- Decouple render rate from update rate; do not block rendering on the simulation loop.
