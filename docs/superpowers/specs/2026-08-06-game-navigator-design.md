# Game navigator: avatar tracking, walkability, routes, effects (game memory v2)

**Date:** 2026-08-06
**Goal:** implement the user's strategy — find the objects, path to each one, observe the
effect, remember it — as plain code in `bench/game-memory.mjs`, so the model only chooses
targets and interprets effects.

## Why

The live LS20 rematch showed the v1 gap: LS20 moves an **avatar inside a static maze**, not
the camera, so shift detection stays silent and "learned buttons" never fills in. The signal
is object motion: the component that vanished at A and reappeared at B after a move is the
avatar, and B−A is that button's meaning.

Out of scope: any game-specific rules; NN; changes outside `bench/`.

## Design (additions to bench/game-memory.mjs)

### Avatar tracking
`trackMover(before, after)` → `{color, cells, from:{x,y}, to:{x,y}} | null` — diff the two
component lists (same bg): the single component (same color, same cell count ≤ 8) present at
different positions is the mover. Ambiguous (0 or >1 candidates) → null.

On an in-place event, `updateMemory` calls `trackMover`; on a hit it:
- sets `state.avatar = {color, cells, x, y}` (screen coords of the mover's bbox top-left);
- tallies the step under `state.moves[action]` exactly like camera shifts (`"dx,dy"` of the
  avatar), so "learned buttons" fills in for avatar games too;
- marks every cell of the vacated footprint walkable (`state.walk["x,y"] = 1`).

An inert move with a known avatar records the wall **cell** ahead: pos + that action's
learned direction (if known) → `state.walls["x,y"] = 1` (in addition to the v1 blocked list).

### Walkability + BFS routes
`routes(state, grid)` → up to 3 nearest objects (components excluding the avatar's own
component and anything larger than 200 cells — backdrops) with a BFS path over cells whose
color is in the walkable color set (colors of cells the avatar has vacated) and not in
`state.walls`, starting from the avatar, ending on any cell 4-adjacent to the object.
Returns `{target: {color, x, y}, path: "→→↓↓…", moves: N}` with arrows mapped back to
actions via the learned meanings (only emitted when at least 2 directions are learned).
BFS is over the 64×64 screen — cheap and always current.

### Effect catalog
When a move lands the avatar 4-adjacent to (or onto) a tracked object and OTHER cells
changed too (beyond the avatar footprint and previously-seen budget-bar band), append
`state.effects` line: `"touched color C at (x,y) → N cells changed at (bbox)"`. Kept across
RESET (that's the knowledge the user wants preserved), capped at 20.

### Summary block additions
- `you are: color 9 (2 cells) at (17,23)` when the avatar is known
- `routes: color 7 at (12,45): →→↓↓→ = ACTION4×2, ACTION2×2, ACTION4 (9 moves); …`
- `effects: …` last 3 lines
- v1 lines stay as they are.

### RESET
`resetMemory` additionally keeps `effects` and the walkable color set; clears `walk`,
`walls`, `avatar` (positions are stale, physics isn't).

## Testing

Extend `test/game-memory.mjs`: mover detection (clean, ambiguous); button learning from
avatar motion; walkable/wall accumulation; BFS route on a synthetic maze with a wall the
path must go around, arrows→actions translation; effect line on adjacency; reset keeps
effects + walkable colors, clears positions. All offline.

## Files touched

`bench/game-memory.mjs`, `bench/arcagi3.mjs` (only if the summary needs the previous grid —
it does not; no wiring change expected), `test/game-memory.mjs`.
