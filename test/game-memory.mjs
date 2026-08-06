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
  assert.ok(tally && tally["-5,0"] === 1, `ACTION3 tallied shift -5,0: ${JSON.stringify(st.moves)}`);
  assert.deepEqual(st.pos, { x: 5, y: 0 }, `pos tracks camera, got ${JSON.stringify(st.pos)}`);
  const covered1 = Object.keys(st.world).length;
  assert.ok(covered1 > 256, `stitching extends beyond one screen: ${covered1}`);
  const r2 = updateMemory(st, "ACTION3", view(5, 0), view(10, 0));
  st = r2.state;
  assert.ok(Object.keys(st.world).length > covered1, "second move maps more world");
  assert.equal(st.moves["ACTION3"]["-5,0"], 2, "meaning learning accumulates");
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
