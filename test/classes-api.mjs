// /v1/classes over HTTP: auth, ownership, sharing, progress, and the body cap. Two seat keys give
// two real identities without any network login.
//   run: node --import tsx test/classes-api.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-classes-api-"));
delete process.env.DATABASE_URL;
delete process.env.ADA_CLIENT_KEYS;
delete process.env.ADA_FREE_TIER;
process.env.ADA_DATA_DIR = dir;
process.env.ADA_AUTH_DB = join(dir, "auth.db");
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const { createSeat } = await import(pathToFileURL(join(base, "src/server/enterprise.ts")).href);
const { createAdaServer } = await import(pathToFileURL(join(base, "src/server/index.ts")).href);
const alice = createSeat("alice");
const bob = createSeat("bob");

const server = createAdaServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (key, method, path, body) => {
  const res = await fetch(origin + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
};
const doc = (id, updatedAt = 100) => ({ id, title: "DNS", status: "ready", updatedAt, scenes: [{}, {}], progress: { sceneIndex: 1 } });

try {
  // no token → the locked (seats exist) backend refuses before the route
  assert.equal((await call(null, "GET", "/v1/classes")).status, 401);

  // owner round trip
  assert.deepEqual((await call(alice, "PUT", "/v1/classes/cls_abcd1234", { doc: doc("cls_abcd1234") })).json, { ok: true, updatedAt: 100 });
  assert.equal((await call(alice, "PUT", "/v1/classes/cls_abcd1234", { doc: doc("cls_zzzz0000") })).status, 400);
  assert.equal((await call(alice, "PUT", "/v1/classes/cls_abcd1234", "{not json")).status, 400);
  assert.equal((await call(alice, "PUT", "/v1/classes/not-an-id", { doc: {} })).status, 400);
  const mine = (await call(alice, "GET", "/v1/classes")).json.classes;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mine, true);
  const one = (await call(alice, "GET", "/v1/classes/cls_abcd1234")).json;
  assert.equal(one.doc.title, "DNS");
  assert.equal(one.doc.progress, undefined);
  assert.equal(one.progress, null);

  // someone else: 403 on write, 404 on read (must not confirm existence)
  assert.equal((await call(bob, "PUT", "/v1/classes/cls_abcd1234", { doc: doc("cls_abcd1234") })).status, 403);
  assert.equal((await call(bob, "GET", "/v1/classes/cls_abcd1234")).status, 404);
  assert.equal((await call(bob, "DELETE", "/v1/classes/cls_abcd1234")).status, 404);

  // share → open by token as bob → in bob's list
  assert.equal((await call(bob, "POST", "/v1/classes/cls_abcd1234/share")).status, 404);
  const share = (await call(alice, "POST", "/v1/classes/cls_abcd1234/share")).json;
  assert.match(share.url, /^https:\/\/adacodelabs\.com\/class\/#[A-Za-z0-9_-]{22}$/);
  assert.equal((await call(bob, "GET", "/v1/classes/shared/short")).status, 404);
  const opened = (await call(bob, "GET", `/v1/classes/shared/${share.token}`)).json;
  assert.equal(opened.id, "cls_abcd1234");
  assert.deepEqual(opened.progress, {});
  const bobs = (await call(bob, "GET", "/v1/classes")).json.classes;
  assert.equal(bobs.length, 1);
  assert.equal(bobs[0].mine, false);
  assert.equal(bobs[0].shareToken, share.token);

  // progress: bob and alice each have their own; newest wins
  assert.deepEqual((await call(bob, "PUT", "/v1/classes/cls_abcd1234/progress", { progress: { sceneIndex: 2, updatedAt: 5 } })).json, { ok: true, stale: false });
  assert.deepEqual((await call(bob, "PUT", "/v1/classes/cls_abcd1234/progress", { progress: { sceneIndex: 0, updatedAt: 4 } })).json, { ok: true, stale: true });
  assert.deepEqual((await call(bob, "GET", `/v1/classes/shared/${share.token}`)).json.progress, { sceneIndex: 2, updatedAt: 5 });
  assert.equal((await call(alice, "GET", "/v1/classes/cls_abcd1234")).json.progress, null);
  assert.equal((await call(bob, "PUT", "/v1/classes/cls_abcd1234/progress", { nope: 1 })).status, 400);

  // body cap
  const big = { doc: { ...doc("cls_abcd1234"), pad: "x".repeat(600_000) } };
  assert.equal((await call(alice, "PUT", "/v1/classes/cls_abcd1234", big)).status, 413);

  // bob removes his own row; the class leaves his list
  assert.equal((await call(bob, "DELETE", "/v1/classes/cls_abcd1234/progress")).status, 204);
  assert.deepEqual((await call(bob, "GET", "/v1/classes")).json.classes, []);
  assert.equal((await call(alice, "DELETE", "/v1/classes/cls_abcd1234/progress")).status, 404);

  // revoke → token dead, bob (re-opened first) can no longer push
  await call(bob, "GET", `/v1/classes/shared/${share.token}`);
  assert.equal((await call(alice, "DELETE", "/v1/classes/cls_abcd1234/share")).status, 204);
  assert.equal((await call(bob, "GET", `/v1/classes/shared/${share.token}`)).status, 404);
  assert.equal((await call(bob, "PUT", "/v1/classes/cls_abcd1234/progress", { progress: { updatedAt: 9 } })).status, 403);
  assert.deepEqual((await call(bob, "GET", "/v1/classes")).json.classes, []);

  // delete cascades
  assert.equal((await call(alice, "DELETE", "/v1/classes/cls_abcd1234")).status, 204);
  assert.equal((await call(alice, "GET", "/v1/classes/cls_abcd1234")).status, 404);
  assert.equal((await call(alice, "GET", "/v1/classes/nope/what")).status, 404);
  console.log("ok");
} finally {
  server.close();
}
