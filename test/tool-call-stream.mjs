// Streamed tool calls arrive as fragments and providers disagree on how they're numbered. Getting
// this wrong splices two calls' arguments into one string, which is silently invalid JSON — the
// request that carries it back is rejected a turn later, far from the cause.
//   run: node --import tsx test/tool-call-stream.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { applyToolCallDelta } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);

const run = (deltas) => {
  const calls = [];
  for (const d of deltas) applyToolCallDelta(calls, d);
  return calls.filter(Boolean);
};
const ok = (calls, label) => {
  for (const c of calls) {
    assert.doesNotThrow(() => JSON.parse(c.args), `${label}: "${c.name}" args are not valid JSON — ${c.args}`);
  }
  return calls;
};

// 1. the well-behaved case: two calls, properly indexed
let c = ok(run([
  { index: 0, id: "a", function: { name: "read_file", arguments: '{"path"' } },
  { index: 1, id: "b", function: { name: "ls", arguments: '{"dir"' } },
  { index: 0, function: { arguments: ':"x.ts"}' } },
  { index: 1, function: { arguments: ':"src"}' } },
]), "indexed");
assert.equal(c.length, 2);
assert.deepEqual(JSON.parse(c[0].args), { path: "x.ts" });
assert.deepEqual(JSON.parse(c[1].args), { dir: "src" });

// 2. THE BUG: a provider that restarts index at 0 for each call. Keying on index alone concatenates
//    them into {"path":"a.ts"}{"dir":"src"} — exactly the payload xAI rejected.
c = ok(run([
  { index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
  { index: 0, id: "b", function: { name: "ls", arguments: '{"dir":"src"}' } },
]), "reused index");
assert.equal(c.length, 2, "a delta with a new id must start a new call even on the same index");
assert.equal(c[0].name, "read_file");
assert.equal(c[1].name, "ls");

// 3. a provider that omits index on continuation deltas
c = ok(run([
  { index: 0, id: "a", function: { name: "grep", arguments: '{"pat' } },
  { function: { arguments: 'tern":"foo"' } },
  { function: { arguments: "}" } },
]), "no index on continuations");
assert.equal(c.length, 1);
assert.deepEqual(JSON.parse(c[0].args), { pattern: "foo" });

// 4. no ids at all — fall back to index, and synthesise stable ids
c = run([
  { index: 0, function: { name: "ls", arguments: "{}" } },
  { index: 1, function: { name: "ls", arguments: "{}" } },
]);
assert.equal(c.length, 2);
assert.ok(c[0].id && c[1].id && c[0].id !== c[1].id, "every call needs its own id");

// 5. a repeated id on the same index is the SAME call continuing, not a new one
c = ok(run([
  { index: 0, id: "a", function: { name: "read_file", arguments: '{"path"' } },
  { index: 0, id: "a", function: { arguments: ':"z.ts"}' } },
]), "repeated id");
assert.equal(c.length, 1);
assert.deepEqual(JSON.parse(c[0].args), { path: "z.ts" });

console.log("ok");
