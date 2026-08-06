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
    avatar: null, // {color, cells, x, y} — the component that moves when you press a button
    walk: {}, // "x,y" → 1 — screen cells the avatar has stood on this attempt
    walls: {}, // "x,y" → 1 — screen cells a move bounced off
    walkColors: [], // colors the avatar has been seen standing on (the floor)
    effects: [], // "touched color C at (x,y) → ..." — what touching things did; survives RESET
    changeFreq: {}, // "x,y" → times changed by non-motion; ≥3 = HUD chrome, not an effect
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

/** Every cell of one component, by flood fill from its bbox corner. */
function cellsOf(grid, comp) {
  const out = [];
  for (let y = comp.y0; y <= comp.y1; y++)
    for (let x = comp.x0; x <= comp.x1; x++) if (grid[y][x] === comp.color) out.push([x, y]);
  return out;
}

/** The single small component that vanished at one place and reappeared at another — the
 *  avatar. null when nothing (or more than one thing) moved that way. */
export function trackMover(before, after) {
  const bg = mostCommonColor(before);
  const key = (c) => `${c.color}:${c.cells}`;
  // ≤64: a sprite can be 5×5×2 colours (LS20's is 25 cells); bars and scenery are bigger.
  const b = components(before, bg).filter((c) => c.cells <= 64);
  const a = components(after, bg).filter((c) => c.cells <= 64);
  const at = (list, c) => list.some((o) => o.color === c.color && o.x0 === c.x0 && o.y0 === c.y0);
  const gone = b.filter((c) => !at(a, c));
  const appeared = a.filter((c) => !at(b, c));
  const movers = gone
    .map((g) => ({ g, n: appeared.filter((p) => key(p) === key(g)) }))
    .filter(({ n }) => n.length === 1);
  if (!movers.length) return null;
  // Several parts all displaced by the same amount = one multi-colour avatar (LS20's
  // sprite is two stacked colours). Different displacements = genuinely ambiguous.
  const delta = ({ g, n }) => `${n[0].x0 - g.x0},${n[0].y0 - g.y0}`;
  if (new Set(movers.map(delta)).size !== 1) return null;
  const parts = movers.sort((p, q) => q.g.cells - p.g.cells);
  const { g, n } = parts[0];
  const toCells = parts.flatMap((p) => cellsOf(after, p.n[0]));
  const xs = toCells.map(([x]) => x);
  const ys = toCells.map(([, y]) => y);
  return {
    color: g.color,
    cells: parts.reduce((s, p) => s + p.g.cells, 0),
    from: { x: Math.min(...parts.map((p) => p.g.x0)), y: Math.min(...parts.map((p) => p.g.y0)) },
    to: { x: Math.min(...xs), y: Math.min(...ys) },
    w: Math.max(...xs) - Math.min(...xs) + 1,
    h: Math.max(...ys) - Math.min(...ys) + 1,
    fromCells: parts.flatMap((p) => cellsOf(before, p.g)),
    toCells,
  };
}

/** dir "dx,dy" → the action whose majority meaning matches it, from learned moves. */
function actionFor(state, dir) {
  for (const [act, tally] of Object.entries(state.moves)) if (meaningOf(tally) === dir) return act;
  return null;
}

/** BFS from the avatar to the 3 nearest interesting objects. Edges are the LEARNED move
 *  vectors (one button press each — a stride game hops 5 cells per press), a position is
 *  valid when the avatar's whole footprint sits on walked-on colors off any known wall,
 *  and a target counts as reached when the footprint touches its bounding box. */
export function routes(state, grid) {
  const av = state.avatar;
  if (!av) return [];
  const edges = [...new Set(Object.values(state.moves).map(meaningOf).filter(Boolean))]
    .map((d) => d.split(",").map(Number))
    .filter(([dx, dy]) => dx || dy);
  if (edges.length < 2) return []; // can't express a path yet
  const bg = mostCommonColor(grid);
  const H = grid.length;
  const W = grid[0]?.length ?? 0;
  const aw = av.w ?? 1;
  const ah = av.h ?? 1;
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x + aw > W || y + ah > H) return false;
    for (let yy = y; yy < y + ah; yy++)
      for (let xx = x; xx < x + aw; xx++) {
        const own = xx >= av.x && xx < av.x + aw && yy >= av.y && yy < av.y + ah;
        if (state.walls[`${xx},${yy}`]) return false;
        if (!own && !state.walkColors.includes(grid[yy][xx]) && grid[yy][xx] !== av.color) return false;
      }
    return true;
  };
  const dist = new Map([[`${av.x},${av.y}`, 0]]);
  const prev = new Map();
  const queue = [[av.x, av.y]];
  while (queue.length) {
    const [cx, cy] = queue.shift();
    const d = dist.get(`${cx},${cy}`);
    for (const [dx, dy] of edges) {
      const k = `${cx + dx},${cy + dy}`;
      if (dist.has(k) || !fits(cx + dx, cy + dy)) continue;
      dist.set(k, d + 1);
      prev.set(k, `${cx},${cy}`);
      queue.push([cx + dx, cy + dy]);
    }
  }
  const targets = components(grid, bg).filter(
    (c) => c.cells <= 200 && !(c.color === av.color && c.x0 >= av.x && c.x1 < av.x + aw && c.y0 >= av.y && c.y1 < av.y + ah),
  );
  const touches = (x, y, t) => x + aw >= t.x0 && x <= t.x1 + 1 && y + ah >= t.y0 && y <= t.y1 + 1;
  const found = [];
  for (const t of targets) {
    let best = null;
    for (const [k, d] of dist) {
      const [x, y] = k.split(",").map(Number);
      if (touches(x, y, t) && (best === null || d < dist.get(best))) best = k;
    }
    if (best === null || dist.get(best) === 0) continue;
    const steps = [];
    for (let k = best; prev.has(k); k = prev.get(k)) {
      const [x, y] = k.split(",").map(Number);
      const [px, py] = prev.get(k).split(",").map(Number);
      steps.unshift(`${x - px},${y - py}`);
    }
    const runs = [];
    for (const s of steps) {
      const act = actionFor(state, s) ?? `?(${s})`;
      const last = runs[runs.length - 1];
      if (last && last.act === act) last.n++;
      else runs.push({ act, n: 1 });
    }
    found.push({
      target: { color: t.color, x: t.x0, y: t.y0 },
      moves: dist.get(best),
      path: runs.map((r) => (r.n > 1 ? `${r.act}×${r.n}` : r.act)).join(", "),
    });
  }
  return found.sort((p, q) => p.moves - q.moves).slice(0, 3);
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
    event = `${action} did nothing here (blocked/inert — a wall?)`;
    // With a tracked avatar and a learned direction, the wall has a screen cell: right ahead.
    const dir = meaningOf(state.moves[action]);
    if (state.avatar && dir) {
      const [dx, dy] = dir.split(",").map(Number);
      const wx = state.avatar.x + dx;
      const wy = state.avatar.y + dy;
      state.walls[`${wx},${wy}`] = 1;
      event = `${action} did nothing — wall at (${wx},${wy})`;
    }
  } else if (sameShape) {
    // Chrome learning first, mover or not: cells that change on nearly every move (an energy
    // bar, a move counter) are HUD, and must not gate or pollute avatar/effect detection.
    for (let y = 0; y < before.length; y++)
      for (let x = 0; x < before[y].length; x++)
        if (before[y][x] !== after[y][x]) state.changeFreq[`${x},${y}`] = (state.changeFreq[`${x},${y}`] ?? 0) + 1;
    const { dx, dy, mismatch } = detectShift(before, after);
    const mover = dx === 0 && dy === 0 ? trackMover(before, after) : null;
    if ((dx !== 0 || dy !== 0) && mismatch <= MOTION_GATE) {
      stitch(state, before); // seed/refresh the map at the old position first
      state.pos = { x: state.pos.x - dx, y: state.pos.y - dy }; // content +dx ⇒ camera −dx
      stitch(state, after);
      // moves always store PLAYER motion, whichever way it was observed (camera or avatar)
      const key = `${-dx},${-dy}`;
      (state.moves[action] ??= {})[key] = ((state.moves[action] ?? {})[key] ?? 0) + 1;
      event = `${action}: you moved (${-dx},${-dy}) — now at world ${state.pos.x},${state.pos.y}`;
    } else if (mover) {
      // Avatar game: the world stands still and one small thing moved — you.
      const mdx = mover.to.x - mover.from.x;
      const mdy = mover.to.y - mover.from.y;
      const key = `${mdx},${mdy}`;
      (state.moves[action] ??= {})[key] = ((state.moves[action] ?? {})[key] ?? 0) + 1;
      state.avatar = { color: mover.color, cells: mover.cells, x: mover.to.x, y: mover.to.y, w: mover.w ?? 1, h: mover.h ?? 1 };
      for (const [x, y] of mover.fromCells) {
        state.walk[`${x},${y}`] = 1;
        const floor = after[y]?.[x];
        if (floor !== undefined && !state.walkColors.includes(floor)) state.walkColors.push(floor);
      }
      event = `${action}: you (color ${mover.color}) moved (${mdx},${mdy}) to (${mover.to.x},${mover.to.y})`;
      event += recordEffect(state, before, after, mover);
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

/** After an avatar move: did anything change beyond the avatar itself? If we're touching an
 *  object and non-HUD cells changed elsewhere, that's an effect worth remembering. */
function recordEffect(state, before, after, mover) {
  const own = new Set([...mover.fromCells, ...mover.toCells].map(([x, y]) => `${x},${y}`));
  const extra = [];
  for (let y = 0; y < before.length; y++)
    for (let x = 0; x < before[y].length; x++)
      if (before[y][x] !== after[y][x] && !own.has(`${x},${y}`)) extra.push([x, y]);
  // changeFreq is tallied once per move in updateMemory, mover or not
  const real = extra.filter(([x, y]) => (state.changeFreq[`${x},${y}`] ?? 0) < 3); // ≥3 = HUD chrome
  if (!real.length) return "";
  const bg = mostCommonColor(after);
  // Cell-level adjacency, smallest component first — a maze's wall ring spans the whole
  // screen by bounding box and would otherwise claim every effect.
  const near = components(after, bg)
    .filter((c) => c.cells <= 200) // a maze's whole wall network is scenery, not a "thing you touched"
    .filter((c) => !(c.color === mover.color && c.x0 === mover.to.x && c.y0 === mover.to.y))
    .sort((p, q) => p.cells - q.cells)
    .find((c) =>
      cellsOf(after, c).some(([x, y]) =>
        mover.toCells.some(([ax, ay]) => Math.abs(ax - x) <= 1 && Math.abs(ay - y) <= 1),
      ),
    );
  if (!near) return "";
  const xs = real.map(([x]) => x);
  const ys = real.map(([, y]) => y);
  const line = `touched color ${near.color} at (${near.x0},${near.y0}) → ${real.length} cells changed at (${Math.min(...xs)}..${Math.max(...xs)}, ${Math.min(...ys)}..${Math.max(...ys)})`;
  state.effects.push(line);
  if (state.effects.length > 20) state.effects.splice(0, state.effects.length - 20);
  return ` · EFFECT: ${line}`;
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
      return m ? `${act} moves you (${m})` : null;
    })
    .filter(Boolean);
  const walls = Object.entries(state.blocked).map(([act, at]) => `${act} failed at: ${[...new Set(at)].slice(-5).join(" ")}`);
  const bg = mostCommonColor(grid);
  const objs = components(grid, bg)
    .slice(0, 6)
    .map((o) => `color ${o.color}×${o.cells} at (${o.x0}..${o.x1}, ${o.y0}..${o.y1})`);
  const paths = routes(state, grid).map(
    (r) => `color ${r.target.color} at (${r.target.x},${r.target.y}): ${r.path} (${r.moves} moves)`,
  );
  return [
    "MEMORY (derived from your moves — trust it over re-deriving):",
    `- last: ${event}`,
    meanings.length ? `- learned buttons: ${meanings.join("; ")}` : "- learned buttons: none yet — try each action once and watch this line",
    state.avatar ? `- you are: color ${state.avatar.color} (${state.avatar.cells} cells) at (${state.avatar.x},${state.avatar.y})` : null,
    paths.length ? `- routes: ${paths.join("; ")}` : null,
    walls.length ? `- ${walls.join("; ")}` : null,
    state.effects.length ? `- effects so far: ${state.effects.slice(-3).join(" | ")}` : null,
    `- position: world ${state.pos.x},${state.pos.y} · mapped ${Object.keys(state.world).length} cells`,
    `- on screen (bg=${bg}): ${objs.join("; ")}`,
    state.log.length > 1 ? `- recent: ${state.log.slice(-4, -1).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** New level attempt: positions are stale, physics and knowledge are not. */
export function resetMemory(state) {
  const fresh = newMemory();
  fresh.moves = structuredClone(state.moves ?? {});
  fresh.blocked = structuredClone(state.blocked ?? {});
  fresh.effects = structuredClone(state.effects ?? []);
  fresh.walkColors = structuredClone(state.walkColors ?? []);
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
