# Game memory: a world model for ARC-style game agents

**Date:** 2026-08-06
**Goal:** stop the agent re-deriving the world every frame. Interpret each new frame *relative
to the last action*, accumulate a persistent map, and hand the model conclusions ("you moved
left 5; wall below you") instead of raw grids.

## Why

An hour-long LS20 run failed on perception, not reasoning: the agent read 64×64 grids as
statistics ("52 cells changed"), mistook camera-follow for "the world scrolls", turned one
blocked move into "DOWN never works", and re-probed the same facts for an hour. Every one of
those errors is mechanical to prevent with plain code — no neural network needed (nothing
here requires training; shift detection and object labeling have exact classical solutions,
and ARC-AGI-3 deliberately defeats pretrained pattern-matching anyway).

Out of scope: any learned/NN component; game-specific rules (must work for every ARC game);
engine (src/) changes — this is bench-side.

## Design

One new pure-function module `bench/game-memory.mjs`, wired into the existing `play` CLI in
`bench/arcagi3.mjs`. State lives in `game-map.json` in the run dir, beside the existing
`arc-session.json`.

### Pure helpers (all exported, all offline-testable)

- `detectShift(a, b, maxShift = 8)` → `{dx, dy, mismatch}` — the translation of grid `b`
  relative to `a` that minimizes mismatched cells over the overlap, ties broken by smaller
  |dx|+|dy|. `mismatch` is the mismatch ratio over the overlap at the best shift. A pure
  in-place change reports `{dx:0, dy:0}`.
- `components(grid, bg)` → array of `{color, cells, x0, y0, x1, y1}` (4-connected regions of
  one color, background excluded), sorted largest-first, capped at 20.
- `updateMemory(state, action, before, after)` → `{state, summary}` — the brain:
  - `countChanged(before, after) === 0` → the move was **inert**: record
    `state.blocked[action]` += list of positions where it failed (the wall signal).
  - else if `detectShift` finds a clean translation (`dx or dy ≠ 0` and `mismatch ≤ 0.15`) →
    **ego-motion**: the camera moved `(-dx, -dy)`; update `state.pos`, tally the shift under
    `state.moves[action]` (majority tally = that action's learned meaning), and stitch
    `after` into `state.world` (sparse `"x,y" → color` at world coordinates).
  - else → **in-place event**: report the changed-cell count and the bounding box of change.
  - Always: refresh `state.step`, append one line to `state.log` (last 30 kept).
- `summarize(state, after)` → the text block shown to the model: what the action did, learned
  action meanings so far ("ACTION1: moves you up 5"), walls recorded near the current
  position, world coverage (`N cells mapped`), and the largest on-screen objects from
  `components`.
- `loadMemory(dir)` / `saveMemory(dir, state)` — `game-map.json` I/O.
- On `RESET`: clear `pos`, `world`, and `log` (a fresh level attempt) but **keep** `moves`
  and `blocked` — what the buttons mean survives death; that's the point of memory.

### Wiring (bench/arcagi3.mjs)

In `play()`: after the action returns (`before` and the new grid are already in hand there),
call `updateMemory` + `summarize` and print the summary block after `formatObs`. On RESET,
apply the reset rule above. `buildAgentPrompt` gains one line telling the agent a MEMORY
block appears after each frame and is derived, trustworthy state.

### Sign convention

Screen content shifting right (+dx) means the camera/player moved left. `state.pos` tracks
the player in world coordinates; world stitching writes `after[y][x]` to world cell
`(x + ox, y + oy)` where `(ox, oy)` is the screen origin in world coordinates, updated by
`(-dx, -dy)` per detected shift. Locked by tests with synthetic grids.

## Error handling

Corrupt or missing `game-map.json` → start fresh (never block a move on memory). Grids of
differing sizes → treat as in-place event (no shift claimed).

## Testing

`test/game-memory.mjs` (plain node, offline, synthetic 16×16 grids): shift detection incl.
ties and the 0.15 mismatch gate; wall recording on inert moves; action-meaning learning
across repeated moves; world stitching accumulates coverage across two moves with the sign
convention right; RESET keeps `moves`/`blocked` but clears `pos`/`world`; corrupt state file
recovers. Plus `node bench/arcagi3.mjs --selftest` still passes.

## Files touched

Create `bench/game-memory.mjs`, `test/game-memory.mjs`. Modify `bench/arcagi3.mjs` (play +
prompt). No dependencies, no engine changes.
