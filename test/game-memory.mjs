// Game memory: interpret frames relative to the last action, remember the world.
// Offline, synthetic grids. run: node test/game-memory.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  components,
  detectShift,
  loadMemory,
  newMemory,
  resetMemory,
  saveMemory,
  updateMemory,
} from "../bench/game-memory.mjs";

// A textured world viewed through a 16x16 window at offset (ox, oy) — every cell moves
// together under camera motion, like a real scrolling playfield.
const tex = (x, y) => ((((x * 31 + y * 17) ^ ((x >> 2) * 7 + (y >> 2) * 5)) % 6) + 6) % 6 + 3;
const view = (ox = 0, oy = 0) => Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => tex(x + ox, y + oy)));

// A flat grid with distinct objects, for components / in-place tests: bg 4, wall stripe, 2x2 blob.
function objGrid() {
  const g = Array.from({ length: 16 }, () => Array(16).fill(4));
  for (let x = 0; x < 16; x++) g[8][x] = 3;
  for (const [x, y] of [[5, 3], [6, 3], [5, 4], [6, 4]]) g[y][x] = 9;
  return g;
}

// ---- detectShift ----
assert.deepEqual(detectShift(view(), view()), { dx: 0, dy: 0, mismatch: 0 }, "identical grids = zero shift");
{
  // camera moved right 3 → content appears shifted left 3 (dx = -3)
  const { dx, dy, mismatch } = detectShift(view(), view(3, 0));
  assert.equal(dx, -3, `content shifted -3 in x, got ${dx}`);
  assert.equal(dy, 0);
  assert.ok(mismatch <= 0.05, `clean translation, got mismatch ${mismatch}`);
}
{
  const { dx, dy } = detectShift(view(), view(0, -2)); // camera up 2 → content down 2
  assert.equal(dx, 0);
  assert.equal(dy, 2, `content shifted +2 in y, got ${dy}`);
}
{
  // unrelated pattern → whatever shift wins must report high mismatch
  const noisy = view().map((row, y) => row.map((_, x) => (x * 7 + y * 13) % 10));
  const { mismatch } = detectShift(view(), noisy);
  assert.ok(mismatch > 0.15, `noise must not look like motion, got ${mismatch}`);
}

// ---- components ----
{
  const objs = components(objGrid(), 4);
  const nine = objs.find((o) => o.color === 9);
  assert.ok(nine, "found the 2x2 object");
  assert.equal(nine.cells, 4);
  assert.deepEqual([nine.x0, nine.y0, nine.x1, nine.y1], [5, 3, 6, 4]);
  const wall = objs.find((o) => o.color === 3);
  assert.equal(wall.cells, 16, "wall stripe is one 16-cell component");
  assert.ok(objs[0].cells >= objs[objs.length - 1].cells, "sorted largest-first");
}

// ---- updateMemory: ego-motion ----
{
  let st = newMemory();
  // player pressed ACTION3; camera moved right 5 (content shift dx = -5)
  const r1 = updateMemory(st, "ACTION3", view(), view(5, 0));
  st = r1.state;
  assert.match(r1.summary, /moved/i, "summary reports motion");
  const tally = st.moves["ACTION3"];
  assert.ok(tally && tally["5,0"] === 1, `ACTION3 tallied player +5,0: ${JSON.stringify(st.moves)}`);
  assert.deepEqual(st.pos, { x: 5, y: 0 }, `pos tracks camera, got ${JSON.stringify(st.pos)}`);
  const covered1 = Object.keys(st.world).length;
  assert.ok(covered1 > 256, `stitching extends beyond one screen: ${covered1}`);
  const r2 = updateMemory(st, "ACTION3", view(5, 0), view(10, 0));
  st = r2.state;
  assert.ok(Object.keys(st.world).length > covered1, "second move maps more world");
  assert.equal(st.moves["ACTION3"]["5,0"], 2, "meaning learning accumulates");
  assert.deepEqual(st.pos, { x: 10, y: 0 });
  // stitched world must agree with the texture at a far-out world coordinate
  assert.equal(st.world["20,7"], tex(20, 7), "world cells stored at true world coords");
}

// ---- updateMemory: inert move = wall ----
{
  const r = updateMemory(newMemory(), "ACTION2", view(), view());
  assert.equal(r.state.blocked["ACTION2"]?.length, 1, "inert move recorded as blocked");
  assert.match(r.summary, /nothing|blocked|inert/i, "summary says the move did nothing");
}

// ---- updateMemory: in-place event ----
{
  const before = objGrid();
  const after = objGrid();
  after[12][12] = 7;
  after[12][13] = 7;
  const { state: st, summary } = updateMemory(newMemory(), "ACTION5", before, after);
  assert.match(summary, /2 cell/i, `reports changed cell count: ${summary}`);
  assert.ok(!st.moves["ACTION5"], "in-place change is not motion");
}

// ---- differing grid sizes: in-place, never a crash ----
{
  const { summary } = updateMemory(newMemory(), "ACTION1", view(), [[1, 2], [3, 4]]);
  assert.ok(summary.length > 0, "size change handled");
}

// ---- RESET semantics ----
{
  let st = newMemory();
  st = updateMemory(st, "ACTION3", view(), view(5, 0)).state;
  st = updateMemory(st, "ACTION2", view(5, 0), view(5, 0)).state;
  const fresh = resetMemory(st);
  assert.deepEqual(fresh.pos, { x: 0, y: 0 }, "pos cleared");
  assert.equal(Object.keys(fresh.world).length, 0, "world cleared");
  assert.ok(fresh.moves["ACTION3"], "learned meanings survive reset");
  assert.ok(fresh.blocked["ACTION2"], "learned walls survive reset");
}

// ---- persistence + corrupt file recovery ----
{
  const dir = mkdtempSync(join(tmpdir(), "gm-"));
  const st = updateMemory(newMemory(), "ACTION3", view(), view(5, 0)).state;
  saveMemory(dir, st);
  const back = loadMemory(dir);
  assert.deepEqual(back.pos, st.pos, "round-trips through disk");
  writeFileSync(join(dir, "game-map.json"), "{corrupt");
  const recovered = loadMemory(dir);
  assert.deepEqual(recovered.pos, { x: 0, y: 0 }, "corrupt file → fresh memory");
}

console.log("game-memory: ok");

// ================= v2: navigator (avatar, walkability, routes, effects) =================
const { trackMover, routes } = await import("../bench/game-memory.mjs");

// A 16x16 maze: floor 5, border walls 3, internal wall column x=8 with a gap at y=12,
// a single-cell avatar (9) at (ax, ay), a 2-cell target (7) at (12, 3..4).
function maze(ax, ay, extra) {
  const g = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return 3;
    if (x === 8 && y !== 12) return 3;
    return 5;
  }));
  g[3][12] = 7;
  g[4][12] = 7;
  g[ay][ax] = 9;
  if (extra) for (const [x, y, c] of extra) g[y][x] = c;
  return g;
}

// ---- trackMover ----
{
  const m = trackMover(maze(2, 2), maze(3, 2));
  assert.ok(m, "mover found");
  assert.equal(m.color, 9);
  assert.deepEqual([m.from.x, m.from.y, m.to.x, m.to.y], [2, 2, 3, 2]);
  assert.equal(trackMover(maze(2, 2), maze(2, 2)), null, "no motion = no mover");
}

// ---- avatar learning through updateMemory ----
{
  let st = newMemory();
  st = updateMemory(st, "ACTION4", maze(2, 2), maze(3, 2)).state; // moved +1 x
  st = updateMemory(st, "ACTION2", maze(3, 2), maze(3, 3)).state; // moved +1 y
  assert.equal(st.moves["ACTION4"]?.["1,0"], 1, `avatar motion tallied: ${JSON.stringify(st.moves)}`);
  assert.equal(st.moves["ACTION2"]?.["0,1"], 1);
  assert.deepEqual({ x: st.avatar.x, y: st.avatar.y }, { x: 3, y: 3 }, "avatar position tracked");
  assert.ok(st.walk["2,2"] && st.walk["3,2"], "vacated cells marked walkable");

  // inert move with a learned direction records the wall CELL ahead
  st = updateMemory(st, "ACTION4", maze(3, 3), maze(3, 3)).state;
  assert.ok(st.walls["4,3"], `wall recorded ahead: ${JSON.stringify(st.walls)}`);

  // learn the remaining two directions — routes only use buttons it has seen work
  st = updateMemory(st, "ACTION3", maze(3, 3), maze(2, 3)).state; // (-1,0)
  st = updateMemory(st, "ACTION1", maze(2, 3), maze(2, 2)).state; // (0,-1)

  // ---- routes: BFS around the internal wall to the target ----
  const r = routes(st, maze(2, 2));
  const toTarget = r.find((q) => q.target.color === 7);
  assert.ok(toTarget, `route to target exists: ${JSON.stringify(r)}`);
  // direct manhattan distance ~ 10; the wall at x=8 forces a detour through (8,12)
  assert.ok(toTarget.moves > 10, `detour is longer than manhattan: ${toTarget.moves}`);
  assert.match(toTarget.path, /ACTION4/, "path expressed in learned actions");
}

// ---- effect catalog: reaching an object while other cells change ----
{
  let st = newMemory();
  st = updateMemory(st, "ACTION4", maze(9, 3), maze(10, 3)).state;
  // next move lands adjacent to the target AND a distant "door" (2,14) flips colour
  st = updateMemory(st, "ACTION4", maze(10, 3), maze(11, 3, [[2, 14, 8], [3, 14, 8]])).state;
  assert.equal(st.effects?.length, 1, `effect logged: ${JSON.stringify(st.effects)}`);
  assert.match(st.effects[0], /color 7/, "effect names the touched object");

  // reset keeps level geometry and knowledge; only the sprite's position goes stale
  const fresh = resetMemory(st);
  assert.equal(fresh.effects.length, 1, "effects survive reset");
  assert.ok(fresh.walkColors.includes(5), "walkable colours survive reset");
  assert.equal(fresh.avatar, null, "avatar position cleared");
  assert.ok(fresh.avatarId, "avatar identity kept for relocation");
  assert.ok(Object.keys(fresh.walk).length > 0, "walk map survives reset — same level restarts");

  // relocation: the remembered sprite is found again in a fresh frame, so routes work immediately
  const { relocateAvatar } = await import("../bench/game-memory.mjs");
  assert.equal(relocateAvatar(fresh, maze(2, 2)), true, "sprite re-found after reset");
  assert.deepEqual({ x: fresh.avatar.x, y: fresh.avatar.y }, { x: 2, y: 2 }, "relocated to start position");
}

// ---- self-effects: a multi-colour sprite's own halves are not "touched objects" ----
{
  function duo(ax, ay, extra) {
    const g = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) =>
      x === 0 || y === 0 || x === 15 || y === 15 ? 3 : 4));
    g[ay][ax] = 12; // top half of the sprite
    g[ay + 1][ax] = 9; // bottom half
    if (extra) for (const [x, y, c] of extra) g[y][x] = c;
    return g;
  }
  // move with a distant unexplained change, nothing adjacent: must NOT log an effect
  const r = updateMemory(newMemory(), "ACTION4", duo(5, 5), duo(6, 5, [[2, 13, 8]]));
  assert.equal(r.state.effects.length, 0, `own sprite half must not read as a touched object: ${JSON.stringify(r.state.effects)}`);
}

console.log("game-memory v2 (navigator): ok");

// ---- v3: composite (multi-color) avatar + chrome learning ----
{
  // LS20-style: avatar is TWO adjacent components (12 and 9) moving together, while a
  // HUD bar (11) at the bottom also changes every move.
  function world(ax, ay, bar) {
    const g = Array.from({ length: 16 }, () => Array(16).fill(4));
    // static maze structure, as in a real game — without it, a 1-cell avatar step is
    // cheaper to explain as camera motion and the shift detector wins
    for (let i = 0; i < 16; i++) { g[0][i] = 3; g[14][i] = 3; g[i][0] = 3; g[i][15] = 3; }
    for (const [x, y] of [[3, 3], [3, 4], [10, 8], [11, 8], [12, 2], [2, 10]]) g[y][x] = 3;
    g[ay][ax] = 12; g[ay][ax + 1] = 12;      // top part of the avatar
    g[ay + 1][ax] = 9; g[ay + 1][ax + 1] = 9; // bottom part
    for (let x = 1; x <= bar; x++) g[15][x] = 11; // shrinking energy bar
    return g;
  }
  const m = trackMover(world(5, 5, 10), world(6, 5, 9));
  assert.ok(m, "composite avatar found despite HUD noise");
  assert.equal(m.cells, 4, `composite counts all parts: ${JSON.stringify(m)}`);
  assert.deepEqual([m.to.x - m.from.x, m.to.y - m.from.y], [1, 0], "delta from composite");

  let st = newMemory();
  st = updateMemory(st, "ACTION4", world(5, 5, 10), world(6, 5, 9)).state;
  assert.equal(st.moves["ACTION4"]?.["1,0"], 1, `composite move tallied: ${JSON.stringify(st.moves)}`);
  assert.ok(st.avatar, "avatar set from composite mover");
  // chrome learning must not depend on a mover being found
  let st2 = newMemory();
  const flat = () => Array.from({ length: 16 }, () => Array(16).fill(4));
  for (let i = 0; i < 3; i++) {
    const a = flat(); const b = flat();
    b[15][2] = 11; // same cell flips every time = HUD chrome
    st2 = updateMemory(st2, "ACTION1", a, b).state;
  }
  assert.ok((st2.changeFreq["2,15"] ?? 0) >= 3, `chrome learned without a mover: ${JSON.stringify(st2.changeFreq)}`);
}
// ---- v3: stride movement (LS20-style — one press hops 5 cells) ----
{
  // 32x32: border walls 1, floor 3, a 5×5 two-colour avatar at anchor (ax,ay), 3×3 target 7.
  function stride(ax, ay) {
    const g = Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) =>
      x === 0 || y === 0 || x === 31 || y === 31 ? 1 : 3));
    for (let y = 6; y < 9; y++) for (let x = 20; x < 23; x++) g[y][x] = 7;
    for (let y = ay; y < ay + 2; y++) for (let x = ax; x < ax + 5; x++) g[y][x] = 12;
    for (let y = ay + 2; y < ay + 5; y++) for (let x = ax; x < ax + 5; x++) g[y][x] = 9;
    return g;
  }
  let st = newMemory();
  st = updateMemory(st, "ACTION4", stride(5, 5), stride(10, 5)).state;   // (5,0)
  st = updateMemory(st, "ACTION2", stride(10, 5), stride(10, 10)).state; // (0,5)
  st = updateMemory(st, "ACTION1", stride(10, 10), stride(10, 5)).state; // (0,-5)
  st = updateMemory(st, "ACTION3", stride(10, 5), stride(5, 5)).state;   // (-5,0)
  assert.equal(st.moves["ACTION4"]?.["5,0"], 1, `stride learned: ${JSON.stringify(st.moves)}`);
  assert.equal(st.avatar.w, 5, "avatar footprint width tracked");
  const r = routes(st, stride(5, 5));
  const toTarget = r.find((q) => q.target.color === 7);
  assert.ok(toTarget, `stride route exists: ${JSON.stringify(r)}`);
  assert.equal(toTarget.moves, 2, `two presses to touch the target: ${JSON.stringify(toTarget)}`);
  assert.match(toTarget.path, /ACTION4×2/, "stride path compressed to presses");
}
console.log("game-memory v3 (composite avatar + strides): ok");
