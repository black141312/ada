// Class storage: owner-scoped documents, an unguessable share token, and per-user progress.
//   run: node --import tsx test/classes-store.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-classes-"));
delete process.env.DATABASE_URL; // sqlite; postgres takes the same SQL shape
process.env.ADA_DATA_DIR = dir;
process.env.ADA_AUTH_DB = join(dir, "auth.db");
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const s = await import(pathToFileURL(join(base, "src/server/classes.ts")).href);

const doc = (id, updatedAt, extra = {}) => ({
  id, title: "DNS", status: "ready", updatedAt, scenes: [{}, {}, {}],
  progress: { sceneIndex: 2 }, _sync: { docPushedAt: 1 }, mine: true, sharedToken: "x",
  ...extra,
});

// --- helpers ---
assert.equal(s.isClassId("cls_abcd1234"), true);
assert.equal(s.isClassId("cls_ABCD1234"), false);
assert.deepEqual(Object.keys(s.stripDoc(doc("cls_abcd1234", 5))).sort(), ["id", "scenes", "status", "title", "updatedAt"]);
assert.equal(s.shareUrl("tok"), "https://adacodelabs.com/class/#tok");

// --- put / get / list, owner scoped ---
const put = await s.putClass("alice", "cls_abcd1234", doc("cls_abcd1234", 100));
assert.deepEqual(put, { ok: true, updatedAt: 100 });
assert.equal((await s.putClass("alice", "cls_abcd1234", doc("cls_other001", 1))).status, 400, "doc.id must match the path id");
assert.equal((await s.putClass("bob", "cls_abcd1234", doc("cls_abcd1234", 200))).status, 403, "someone else's id");
const got = await s.getClass("alice", "cls_abcd1234");
assert.equal(got.doc.title, "DNS");
assert.equal(got.doc.progress, undefined, "progress is never inside the stored doc");
assert.equal(got.progress, null);
assert.equal(await s.getClass("bob", "cls_abcd1234"), null);
assert.deepEqual(await s.listClasses("alice"), [{ id: "cls_abcd1234", title: "DNS", status: "ready", updatedAt: 100, sceneCount: 3, mine: true }]);
assert.deepEqual(await s.listClasses("bob"), []);

// --- share / open by token ---
assert.equal(await s.shareClass("bob", "cls_abcd1234"), null);
const share = await s.shareClass("alice", "cls_abcd1234");
assert.match(share.token, /^[A-Za-z0-9_-]{22}$/);
assert.equal(share.url, s.shareUrl(share.token));
assert.equal((await s.shareClass("alice", "cls_abcd1234")).token, share.token, "idempotent");
assert.equal(await s.getShared("bob", "short"), null, "tokens under 20 chars never hit the database");
assert.equal(await s.getShared("bob", "A".repeat(22)), null);
const opened = await s.getShared("bob", share.token);
assert.equal(opened.id, "cls_abcd1234");
assert.equal(opened.doc.title, "DNS");
assert.deepEqual(opened.progress, {});
const bobList = await s.listClasses("bob");
assert.equal(bobList.length, 1);
assert.equal(bobList[0].mine, false);
assert.equal(bobList[0].shareToken, share.token);
assert.equal(bobList[0].progressUpdatedAt, 0);
assert.equal((await s.listClasses("alice"))[0].shareToken, share.token, "the owner sees the token too");

// --- progress: newest wins, independently ---
assert.deepEqual(await s.putProgress("bob", "cls_abcd1234", { sceneIndex: 3, updatedAt: 50 }), { ok: true, stale: false });
assert.deepEqual(await s.putProgress("bob", "cls_abcd1234", { sceneIndex: 1, updatedAt: 40 }), { ok: true, stale: true });
assert.deepEqual((await s.getShared("bob", share.token)).progress, { sceneIndex: 3, updatedAt: 50 });
assert.equal((await s.putProgress("carol", "cls_abcd1234", { updatedAt: 1 })).status, 403, "never opened it");
assert.deepEqual(await s.putProgress("alice", "cls_abcd1234", { sceneIndex: 9, updatedAt: 60 }), { ok: true, stale: false });
assert.deepEqual((await s.getClass("alice", "cls_abcd1234")).progress, { sceneIndex: 9, updatedAt: 60 });

// --- doc update keeps progress; newer doc wins on updatedAt only ---
await s.putClass("alice", "cls_abcd1234", doc("cls_abcd1234", 300, { title: "DNS v2" }));
assert.equal((await s.getShared("bob", share.token)).doc.title, "DNS v2");
assert.deepEqual((await s.getShared("bob", share.token)).progress, { sceneIndex: 3, updatedAt: 50 });

// --- revoke: viewers drop out of the list and can no longer push ---
assert.equal(await s.unshareClass("alice", "cls_abcd1234"), true);
assert.equal(await s.getShared("bob", share.token), null);
assert.deepEqual(await s.listClasses("bob"), []);
assert.equal((await s.putProgress("bob", "cls_abcd1234", { updatedAt: 99 })).status, 403);
assert.equal((await s.shareClass("alice", "cls_abcd1234")).token !== share.token, true, "a new share mints a new token");

// --- re-share does not re-admit an opener who never saw the new token ---
const t2b = (await s.shareClass("alice", "cls_abcd1234")).token;
assert.deepEqual(await s.listClasses("bob"), [], "bob opened under the old token");
assert.equal((await s.putProgress("bob", "cls_abcd1234", { updatedAt: 55 })).status, 403);
await s.getShared("bob", t2b);
assert.equal((await s.listClasses("bob")).length, 1, "opening with the new token re-admits him");
assert.deepEqual((await s.getShared("bob", t2b)).progress, { sceneIndex: 3, updatedAt: 50 }, "and keeps his progress");

// --- opener removes their own row; owner cannot ---
const t2 = (await s.shareClass("alice", "cls_abcd1234")).token;
await s.getShared("bob", t2);
assert.equal((await s.listClasses("bob")).length, 1);
assert.equal(await s.deleteProgress("bob", "cls_abcd1234"), true);
assert.deepEqual(await s.listClasses("bob"), []);
await s.putProgress("alice", "cls_abcd1234", { sceneIndex: 1, updatedAt: 70 }); // alice now has her own row
assert.equal(await s.deleteProgress("alice", "cls_abcd1234"), false);
assert.deepEqual((await s.getClass("alice", "cls_abcd1234")).progress, { sceneIndex: 1, updatedAt: 70 }, "the owner's row survives her own deleteProgress");

// --- delete cascades ---
await s.getShared("bob", t2);
assert.deepEqual(await s.putProgress("bob", "cls_abcd1234", { sceneIndex: 5, updatedAt: 90 }), { ok: true, stale: false });
assert.equal(await s.deleteClass("bob", "cls_abcd1234"), false);
assert.equal(await s.deleteClass("alice", "cls_abcd1234"), true);
assert.equal(await s.getClass("alice", "cls_abcd1234"), null);
assert.deepEqual(await s.listClasses("bob"), []);
assert.equal(await s.getShared("bob", t2), null);

// --- cascade is real: after delete + re-create, no ghost progress row survives ---
await s.putClass("alice", "cls_abcd1234", doc("cls_abcd1234", 400));
const t3 = (await s.shareClass("alice", "cls_abcd1234")).token;
assert.deepEqual(await s.listClasses("bob"), [], "bob's old row must have gone with the delete");
assert.equal((await s.putProgress("bob", "cls_abcd1234", { updatedAt: 1 })).status, 403, "no row, no push");
await s.getShared("bob", t3);
assert.deepEqual((await s.getShared("bob", t3)).progress, {}, "a cascaded delete leaves no ghost progress: bob starts fresh");
assert.equal((await s.listClasses("bob")).length, 1);
console.log("ok");
