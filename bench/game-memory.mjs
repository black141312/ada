// Game memory for ARC-style agents: interpret each frame RELATIVE TO THE LAST ACTION instead
// of from scratch. Plain code does the seeing (shift detection, object labeling, map stitching)
// so the model can spend its turns thinking. No neural net: every job here has an exact
// classical solution, and ARC-AGI-3 is designed to defeat pretrained pattern-matching anyway.
//
// State lives in game-map.json in the run dir, next to arc-session.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "game-map.json";
const MAX_SHIFT = 8;
// Above this fraction of mismatched cells, a "best shift" is coincidence, not camera motion.
const MOTION_GATE = 0.15;

export function newMemory() {
  return {
    step: 0,
    pos: { x: 0, y: 0 }, // where the screen's (0,0) sits in world coordinates
    world: {}, // "x,y" → color, stitched from every frame seen this attempt
    moves: {}, // action → { "dx,dy" → count } — what each button empirically does
    blocked: {}, // action → ["x,y" ...] — positions where that action did nothing
    log: [], // last 30 one-line events, newest last
  };
}

/** Translation of `b` relative to `a` (b[y][x] ≈ a[y-dy][x-dx]) minimizing mismatch over the
 *  overlap; ties go to the smaller |dx|+|dy|. mismatch is a ratio in [0,1]. */
export function detectShift(a, b, maxShift = MAX_SHIFT) {
  const h = Math.min(a.length, b.length);
  const w = Math.min(a[0]?.length ?? 0, b[0]?.length ?? 0);
  let best = { dx: 0, dy: 0, mismatch: 1 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let bad = 0;
      let n = 0;
      for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++) {
        const ra = a[y - dy];
        const rb = b[y];
        for (let x = Math.max(0, dx); x < Math.min(w, w + dx); x++) {
          n++;
          if (ra[x - dx] !== rb[x]) bad++;
        }
      }
      if (!n) continue;
      const mismatch = bad / n;
      const better =
        mismatch < best.mismatch ||
        (mismatch === best.mismatch && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy));
      if (better) best = { dx, dy, mismatch };
    }
  }
  return best;
}

/** 4-connected same-color regions, background excluded, largest first, top 20. */
export function components(grid, bg) {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const seen = Array.from({ length: h }, () => new Uint8Array(w));
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (seen[y][x] || grid[y][x] === bg) continue;
      const color = grid[y][x];
      let cells = 0;
      let x0 = x, y0 = y, x1 = x, y1 = y;
      const stack = [[x, y]];
      seen[y][x] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells++;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && !seen[ny][nx] && grid[ny][nx] === color) {
            seen[ny][nx] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      out.push({ color, cells, x0, y0, x1, y1 });
    }
  }
  return out.sort((p, q) => q.cells - p.cells).slice(0, 20);
}

function countChanged(a, b) {
  let n = 0;
  for (let y = 0; y < Math.max(a.length, b.length); y++) {
    const ra = a[y] ?? [];
    const rb = b[y] ?? [];
    for (let x = 0; x < Math.max(ra.length, rb.length); x++) if (ra[x] !== rb[x]) n++;
  }
  return n;
}

function stitch(state, grid) {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) state.world[`${x + state.pos.x},${y + state.pos.y}`] = row[x];
  }
}

function mostCommonColor(grid) {
  const tally = new Map();
  for (const row of grid) for (const c of row) tally.set(c, (tally.get(c) ?? 0) + 1);
  return [...tally.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
}

/** Majority observed shift for an action, e.g. "-5,0", or null before any observation. */
function meaningOf(tally) {
  const top = Object.entries(tally ?? {}).sort((p, q) => q[1] - p[1])[0];
  return top ? top[0] : null;
}

function pushLog(state, line) {
  state.log.push(`#${state.step} ${line}`);
  if (state.log.length > 30) state.log.splice(0, state.log.length - 30);
}

/** The brain: classify what `action` did (motion / wall / in-place event), update the map,
 *  and produce the summary text shown to the model. */
export function updateMemory(state, action, before, after) {
  state.step++;
  const changed = countChanged(before, after);
  const sameShape = before.length === after.length && (before[0]?.length ?? 0) === (after[0]?.length ?? 0);
  let event;

  if (changed === 0) {
    (state.blocked[action] ??= []).push(`${state.pos.x},${state.pos.y}`);
    event = `${action} did nothing here (blocked/inert at world ${state.pos.x},${state.pos.y} — a wall?)`;
  } else if (sameShape) {
    const { dx, dy, mismatch } = detectShift(before, after);
    if ((dx !== 0 || dy !== 0) && mismatch <= MOTION_GATE) {
      stitch(state, before); // seed/refresh the map at the old position first
      state.pos = { x: state.pos.x - dx, y: state.pos.y - dy }; // content +dx ⇒ camera −dx
      stitch(state, after);
      const key = `${dx},${dy}`;
      (state.moves[action] ??= {})[key] = ((state.moves[action] ?? {})[key] ?? 0) + 1;
      event = `${action}: you moved (${-dx},${-dy}) — now at world ${state.pos.x},${state.pos.y}`;
    } else {
      const b = boundsOfChange(before, after);
      event = `${action}: ${changed} cells changed in place (x ${b.x0}..${b.x1}, y ${b.y0}..${b.y1}) — an interaction, not movement`;
      stitch(state, after);
    }
  } else {
    event = `${action}: grid size changed (${before.length}→${after.length} rows) — treat as a scene change`;
  }

  pushLog(state, event);
  return { state, summary: summarize(state, after, event) };
}

function boundsOfChange(a, b) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== (b[y] ?? [])[x]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** The MEMORY block the model reads after each frame: conclusions, not raw data. */
export function summarize(state, grid, event) {
  const meanings = Object.entries(state.moves)
    .map(([act, tally]) => {
      const m = meaningOf(tally);
      if (!m) return null;
      const [dx, dy] = m.split(",").map(Number);
      return `${act} moves you (${-dx},${-dy})`;
    })
    .filter(Boolean);
  const walls = Object.entries(state.blocked).map(([act, at]) => `${act} failed at: ${[...new Set(at)].slice(-5).join(" ")}`);
  const bg = mostCommonColor(grid);
  const objs = components(grid, bg)
    .slice(0, 6)
    .map((o) => `color ${o.color}×${o.cells} at (${o.x0}..${o.x1}, ${o.y0}..${o.y1})`);
  return [
    "MEMORY (derived from your moves — trust it over re-deriving):",
    `- last: ${event}`,
    meanings.length ? `- learned buttons: ${meanings.join("; ")}` : "- learned buttons: none yet — try each action once and watch this line",
    walls.length ? `- ${walls.join("; ")}` : null,
    `- position: world ${state.pos.x},${state.pos.y} · mapped ${Object.keys(state.world).length} cells`,
    `- on screen (bg=${bg}): ${objs.join("; ")}`,
    state.log.length > 1 ? `- recent: ${state.log.slice(-4, -1).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** New level attempt: the map is stale, but what the buttons mean is not. */
export function resetMemory(state) {
  const fresh = newMemory();
  fresh.moves = structuredClone(state.moves ?? {});
  fresh.blocked = structuredClone(state.blocked ?? {});
  return fresh;
}

export function loadMemory(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    return { ...newMemory(), ...s };
  } catch {
    return newMemory(); // missing or corrupt — never block a move on memory
  }
}

export function saveMemory(dir, state) {
  writeFileSync(join(dir, FILE), JSON.stringify(state));
}
