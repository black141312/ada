// Ada Tutor institutes: the seed, the store, the daily doubt count, and the entitlement decision.
// The decision is the part that can leak money — a header that escapes the price gate — so every
// branch of it is pinned here, as a pure function and through the gate with a fake store.
//   run: node --import tsx test/institutes.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-institutes-"));
delete process.env.DATABASE_URL; // sqlite; postgres takes the same SQL shape
process.env.ADA_DATA_DIR = dir;
process.env.ADA_AUTH_DB = join(dir, "auth.db");
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const I = await import(pathToFileURL(join(base, "src/server/institutes.ts")).href);
const { DEMO, CALLS_PER_DOUBT, DAILY_LIMIT_MESSAGE, decideInstitute, instituteGate, isSlug, isDoubtId, dayOf } = I;

// --- seed + store -------------------------------------------------------------
const demo = await I.getInstitute("demo");
assert.deepEqual(demo, DEMO, "the demo institute is created on first use");
assert.equal(demo.model, "anthropic/claude-haiku-4.5");
assert.equal(demo.dailyDoubtsPerStudent, 30);
assert.deepEqual(await I.publicInstitute("demo"), { slug: "demo", name: "Demo Coaching", logoUrl: null }, "public view carries no model or cap");
assert.equal(await I.getInstitute("nope"), null);
assert.equal(await I.getInstitute("Bad Slug!"), null, "an invalid slug never reaches SQL");

await I.putInstitute({ ...DEMO, slug: "acme", name: "Acme Classes", logoUrl: "https://x/logo.png", dailyDoubtsPerStudent: 5 });
assert.equal((await I.getInstitute("acme")).name, "Acme Classes");
await I.putInstitute({ ...DEMO, slug: "acme", name: "Acme Classes", logoUrl: null, dailyDoubtsPerStudent: 5, active: false });
assert.equal((await I.getInstitute("acme")).active, false, "put replaces");
assert.equal(await I.publicInstitute("acme"), null, "an inactive institute is invisible");
// Re-running ensure's seed must not clobber an operator's edit of demo.
await I.putInstitute({ ...DEMO, name: "Demo Coaching (edited)" });
assert.equal((await I.getInstitute("demo")).name, "Demo Coaching (edited)");
await I.putInstitute(DEMO);

// membership: idempotent
assert.equal(await I.isMember("demo", "stu"), false);
await I.ensureMember("demo", "stu");
await I.ensureMember("demo", "stu");
assert.equal(await I.isMember("demo", "stu"), true);

// doubt counting: distinct doubts per (institute, student, day); calls per doubt
const day = "2026-09-26";
assert.deepEqual(await I.doubtStats("demo", "stu", day, "cls_aaaaaaaa"), { doubtsToday: 0, doubtCalls: null });
await I.recordDoubtCall("demo", "stu", day, "cls_aaaaaaaa");
await I.recordDoubtCall("demo", "stu", day, "cls_aaaaaaaa");
await I.recordDoubtCall("demo", "stu", day, "cls_bbbbbbbb");
assert.deepEqual(await I.doubtStats("demo", "stu", day, "cls_aaaaaaaa"), { doubtsToday: 2, doubtCalls: 2 });
assert.deepEqual(await I.doubtStats("demo", "stu", day, "cls_cccccccc"), { doubtsToday: 2, doubtCalls: null });
assert.equal((await I.doubtStats("demo", "stu", "2026-09-27", "cls_aaaaaaaa")).doubtsToday, 0, "a new day starts at zero");
assert.equal((await I.doubtStats("demo", "other", day, "cls_aaaaaaaa")).doubtsToday, 0, "counts are per student");
assert.equal((await I.doubtStats("acme", "stu", day, "cls_aaaaaaaa")).doubtsToday, 0, "counts are per institute");

// --- validators ---------------------------------------------------------------
assert.ok(isSlug("demo") && isSlug("a") && isSlug("iit-prep-2") && !isSlug("-x") && !isSlug("x-") && !isSlug("Demo") && !isSlug("a".repeat(41)));
assert.ok(isDoubtId("cls_ab12cd34") && !isDoubtId("cls_AB12CD34") && !isDoubtId("cls_1") && !isDoubtId("x"));
assert.equal(dayOf(Date.UTC(2026, 8, 26, 23, 59)), "2026-09-26");

// --- the decision (pure) ------------------------------------------------------
const fresh = { doubtsToday: 0, doubtCalls: null };
const ok = { slug: "demo", institute: DEMO, model: DEMO.model, doubtId: "cls_aaaaaaaa", banned: false, stats: fresh };
assert.deepEqual(decideInstitute(ok), { kind: "waive", slug: "demo", doubtId: "cls_aaaaaaaa", newDoubt: true });
assert.deepEqual(decideInstitute({ ...ok, slug: null }), { kind: "none" }, "no header → today's rules");
assert.deepEqual(decideInstitute({ ...ok, institute: null }), { kind: "none" }, "unknown institute → today's rules");
assert.deepEqual(decideInstitute({ ...ok, institute: { ...DEMO, active: false } }), { kind: "none" }, "inactive → today's rules");
assert.deepEqual(decideInstitute({ ...ok, institute: { ...DEMO, slug: "acme" } }), { kind: "none" }, "the looked-up institute must be the one named");
assert.deepEqual(decideInstitute({ ...ok, model: "anthropic/claude-opus-5" }), { kind: "none" }, "another model is never waived");
assert.deepEqual(decideInstitute({ ...ok, model: "Anthropic/Claude-Haiku-4.5" }), { kind: "none" }, "the model must match exactly");
assert.deepEqual(decideInstitute({ ...ok, doubtId: null }), { kind: "none" }, "no doubt id → nothing to count → no waiver");
assert.equal(decideInstitute({ ...ok, banned: true }).status, 403, "a banned student is refused, not waived");
const full = decideInstitute({ ...ok, stats: { doubtsToday: 30, doubtCalls: null } });
assert.deepEqual(full, { kind: "deny", status: 429, message: DAILY_LIMIT_MESSAGE }, "the 31st doubt of the day is refused");
assert.equal(decideInstitute({ ...ok, stats: { doubtsToday: 29, doubtCalls: null } }).kind, "waive", "the 30th is allowed");
assert.deepEqual(
  decideInstitute({ ...ok, stats: { doubtsToday: 30, doubtCalls: 4 } }),
  { kind: "waive", slug: "demo", doubtId: "cls_aaaaaaaa", newDoubt: false },
  "a doubt already counted today keeps working at the cap (follow-ups, scene repairs)",
);
assert.equal(decideInstitute({ ...ok, stats: { doubtsToday: 1, doubtCalls: CALLS_PER_DOUBT } }).status, 429, "one doubt id can't be reused forever");

// --- the gate with a fake store -----------------------------------------------
function fakeStore(over = {}) {
  const log = [];
  const store = {
    log,
    getInstitute: async (s) => (log.push(["get", s]), s === "demo" ? DEMO : null),
    ensureMember: async (s, u) => void log.push(["member", s, u]),
    doubtStats: async (...a) => (log.push(["stats", ...a]), over.stats ?? fresh),
    recordDoubtCall: async (...a) => void log.push(["record", ...a]),
    isBanned: async () => over.banned ?? false,
  };
  return store;
}
const req = (h) => ({ headers: h });
const NOW = Date.UTC(2026, 8, 26, 10);
{
  const s = fakeStore();
  const d = await instituteGate(s, req({ "x-ada-institute": "demo", "x-ada-doubt": "cls_aaaaaaaa" }), "stu", DEMO.model, NOW);
  assert.equal(d.kind, "waive");
  assert.deepEqual(s.log, [["get", "demo"], ["member", "demo", "stu"], ["stats", "demo", "stu", "2026-09-26", "cls_aaaaaaaa"], ["record", "demo", "stu", "2026-09-26", "cls_aaaaaaaa"]]);
}
{
  const s = fakeStore();
  assert.equal((await instituteGate(s, req({}), "stu", DEMO.model, NOW)).kind, "none");
  assert.deepEqual(s.log, [], "no header → no lookups at all");
}
{
  const s = fakeStore();
  assert.equal((await instituteGate(s, req({ "x-ada-institute": "DEMO'; drop table x" }), "stu", DEMO.model, NOW)).kind, "none");
  assert.deepEqual(s.log, [], "a malformed slug is ignored before any lookup");
}
{
  const s = fakeStore();
  assert.equal((await instituteGate(s, req({ "x-ada-institute": "demo" }), "stu", "anthropic/claude-opus-5", NOW)).kind, "none");
  assert.deepEqual(s.log, [["get", "demo"], ["member", "demo", "stu"]], "other model: membership recorded, nothing counted");
}
{
  const s = fakeStore();
  assert.equal((await instituteGate(s, req({ "x-ada-institute": "demo", "x-ada-doubt": "not-an-id" }), "stu", DEMO.model, NOW)).kind, "none");
  assert.ok(!s.log.some((l) => l[0] === "record"), "a bad doubt id is not counted and not waived");
}
{
  const s = fakeStore({ stats: { doubtsToday: 30, doubtCalls: null } });
  const d = await instituteGate(s, req({ "x-ada-institute": "demo", "x-ada-doubt": "cls_aaaaaaaa" }), "stu", DEMO.model, NOW);
  assert.equal(d.status, 429);
  assert.ok(!s.log.some((l) => l[0] === "record"), "a refused doubt is not recorded");
}
{
  const s = fakeStore({ banned: true });
  assert.equal((await instituteGate(s, req({ "x-ada-institute": "demo", "x-ada-doubt": "cls_aaaaaaaa" }), "stu", DEMO.model, NOW)).status, 403);
}
{
  const s = fakeStore();
  assert.equal((await instituteGate(s, req({ "x-ada-institute": "ghost", "x-ada-doubt": "cls_aaaaaaaa" }), "stu", DEMO.model, NOW)).kind, "none");
  assert.deepEqual(s.log, [["get", "ghost"]], "unknown institute: no membership, nothing counted");
}

// --- the gate against the real store: 30 doubts, then refused ----------------
{
  const h = (n) => req({ "x-ada-institute": "demo", "x-ada-doubt": `cls_${String(n).padStart(8, "0")}` });
  for (let n = 1; n <= 30; n++) assert.equal((await instituteGate(I.dbStore, h(n), "capper", DEMO.model, NOW)).kind, "waive", `doubt ${n}`);
  assert.equal((await instituteGate(I.dbStore, h(31), "capper", DEMO.model, NOW)).status, 429, "31st distinct doubt refused");
  assert.equal((await instituteGate(I.dbStore, h(7), "capper", DEMO.model, NOW)).kind, "waive", "an earlier doubt still works");
  assert.equal((await instituteGate(I.dbStore, h(31), "capper", DEMO.model, NOW + 86_400_000)).kind, "waive", "tomorrow it resets");
  assert.equal(await I.isMember("demo", "capper"), true);
}

console.log("ok");
