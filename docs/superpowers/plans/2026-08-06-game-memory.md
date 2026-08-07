# Game Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bench/game-memory.mjs` — interpret each frame relative to the last action, keep a persistent world map, and print conclusions the model can use.

**Architecture:** Pure functions (shift detection, connected components, memory update, summary) + JSON state file per run dir, wired into the existing `play` CLI in `bench/arcagi3.mjs`.

**Tech Stack:** Plain Node ESM, no dependencies; assert-based offline test.

## Global Constraints

- No new dependencies; no NN; no engine (src/) changes.
- Spec: `docs/superpowers/specs/2026-08-06-game-memory-design.md`. Branch: `game-memory`.
- Shift gate: mismatch ≤ 0.15; max shift ±8; ties → smaller |dx|+|dy|.
- RESET keeps `moves` + `blocked`, clears `pos`/`world`/`log`. Corrupt state → fresh start.
- After: `node test/game-memory.mjs`, `node bench/arcagi3.mjs --selftest`, `npm run typecheck` all pass.

### Task 1: bench/game-memory.mjs + test/game-memory.mjs (TDD)

**Files:** Create `bench/game-memory.mjs`, `test/game-memory.mjs`.

**Interfaces produced:** `detectShift(a,b,maxShift?)`, `components(grid,bg?)`, `newMemory()`, `updateMemory(state,action,before,after)` → `{state,summary}`, `summarize(state,after)`, `loadMemory(dir)`, `saveMemory(dir,state)`, `resetMemory(state)`.

- [ ] Step 1: Write failing test covering every spec bullet (synthetic 16×16 grids)
- [ ] Step 2: Run `node test/game-memory.mjs` — expect failure (module missing)
- [ ] Step 3: Implement `bench/game-memory.mjs`
- [ ] Step 4: Test passes
- [ ] Step 5: Commit

### Task 2: Wire into arcagi3.mjs

**Files:** Modify `bench/arcagi3.mjs` — `play()` prints the MEMORY block after `formatObs`; RESET path calls `resetMemory`; `buildAgentPrompt` mentions the MEMORY block.

**Interfaces consumed:** Task 1 exports.

- [ ] Step 1: Wire `play()` (action path + RESET path) and the prompt line
- [ ] Step 2: `node bench/arcagi3.mjs --selftest` passes; `npm run typecheck` clean
- [ ] Step 3: Commit
