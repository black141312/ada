// Ada Tutor over HTTP: the public institute route, the institute waiver in /v1/chat/completions
// (and everything that must NOT get it), the daily doubt cap, usage rows tagged with the institute
// and kept off the student's own spend, and /v1/tutor/speech with a fake engine.
//
// Identity: ADA_CLIENT_KEYS gives a signed-in, non-enterprise user ("team") on the free plan —
// exactly a student. OpenRouter points at a local fake so a waived call completes end to end.
//   run: node --import tsx test/tutor-api.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-tutor-api-"));
for (const k of ["DATABASE_URL", "ADA_FREE_TIER", "ADA_ADMIN_KEY", "ADA_ADMIN_USERS", "ADA_ALLOWED_USERS", "ADA_UPSTREAM_URL", "BETTER_AUTH_ENABLED", "ADA_OIDC_ISSUER", "ADA_FREE_MODELS", "ADA_TTS_CACHE_DIR"]) delete process.env[k];
process.env.ADA_CLIENT_KEYS = "student-key";
// SQLite by default; ADA_TEST_DATABASE_URL (a FRESH throwaway database) runs it all on Postgres.
const PG = process.env.ADA_TEST_DATABASE_URL;
if (PG) process.env.DATABASE_URL = PG;
process.env.ADA_DATA_DIR = dir;
process.env.ADA_AUTH_DB = join(dir, "auth.db");
process.env.ADA_SPEECH_PER_MINUTE = "3"; // only synthesised (uncached) lines count
process.env.HOME = process.env.USERPROFILE = dir; // no stored provider credentials leak in
process.env.OPENROUTER_API_KEY = "test-key";
process.env.ADA_SPEECH_PROVIDER = "kokoro"; // the OpenRouter voice path has its own test (speech-openrouter.mjs)
process.chdir(dir);

// The fake OpenRouter: answers every chat with a tiny completion that reports usage.
const upstreamHits = [];
const upstreamBodies = [];
const SERVED = "anthropic/claude-4.5-haiku-20251001"; // what OpenRouter says it actually ran
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits.push(JSON.parse(body).model);
    upstreamBodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: SERVED, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));

const base = resolve(import.meta.dirname, "..");
const mod = (p) => import(pathToFileURL(join(base, p)).href);
const { PROVIDERS } = await mod("src/server/config.ts");
PROVIDERS.openrouter.baseURL = `http://127.0.0.1:${fake.address().port}`;
const { createAdaServer } = await mod("src/server/index.ts");
const I = await mod("src/server/institutes.ts");
const S = await mod("src/server/speech-kokoro.ts");

const server = createAdaServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, { key = "student-key", headers = {}, body } = {}) => {
  const res = await fetch(origin + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: res.status, json, buf, headers: res.headers };
};
const HAIKU = "anthropic/claude-haiku-4.5";
const chat = (model, headers = {}, extra = {}) => call("POST", "/v1/chat/completions", { headers, body: { model, messages: [{ role: "user", content: "2+2?" }], ...extra } });
const doubt = (n) => ({ "x-ada-institute": "demo", "x-ada-doubt": `cls_${String(n).padStart(8, "0")}` });
// Read the store directly, on whichever engine the server is using.
let lite = null;
const q = async (sql) => {
  if (PG) return (await (await mod("src/server/db.ts")).authDatabase().query(sql)).rows;
  lite ??= new (createRequire(import.meta.url)(join(base, "node_modules/better-sqlite3")))(join(dir, "auth.db"), { readonly: true });
  return lite.prepare(sql).all();
};
const doubtRows = async () => Number((await q("select count(*) as n from institute_doubts where user_id = 'team'"))[0].n);
const settle = () => new Promise((r) => setTimeout(r, 150)); // usage rows are written fire-and-forget

try {
  // --- public branding --------------------------------------------------------------------------
  const pub = await call("GET", "/v1/institutes/demo", { key: null });
  assert.equal(pub.status, 200, "readable before sign-in");
  assert.deepEqual(pub.json, { slug: "demo", name: "Demo Coaching", logoUrl: null }, "no model, no cap");
  assert.equal((await call("GET", "/v1/institutes/nobody", { key: null })).status, 404);
  assert.equal((await call("GET", "/v1/institutes/BAD!", { key: null })).status, 404);
  await I.putInstitute({ ...I.DEMO, slug: "closed", name: "Closed", active: false });
  assert.equal((await call("GET", "/v1/institutes/closed", { key: null })).status, 404, "inactive is 404");

  // --- today's rules without the waiver -----------------------------------------------------------
  const plain = await chat(HAIKU);
  assert.equal(plain.status, 403, "a free student can't use Haiku on their own plan");
  assert.equal(plain.json.error.type, "plan_restricted");
  assert.equal((await chat(HAIKU, { "x-ada-institute": "demo" })).status, 403, "institute without a doubt id: no waiver");
  assert.equal((await chat(HAIKU, { "x-ada-institute": "demo", "x-ada-doubt": "nope" })).status, 403, "malformed doubt id: no waiver");
  assert.equal((await chat("anthropic/claude-opus-4.5", doubt(1))).status, 403, "another model is never waived");
  assert.equal((await chat(HAIKU, { "x-ada-institute": "closed", "x-ada-doubt": "cls_00000001" })).status, 403, "inactive institute: no waiver");
  assert.equal((await chat(HAIKU, { "x-ada-institute": "ghost", "x-ada-doubt": "cls_00000001" })).status, 403, "unknown institute: no waiver");
  assert.equal((await call("POST", "/v1/chat/completions", { key: null, headers: doubt(1), body: { model: HAIKU, messages: [] } })).status, 401, "signed out: no waiver");
  assert.equal(upstreamHits.length, 0, "nothing above reached the provider");

  // --- the waiver ---------------------------------------------------------------------------------
  const ok = await chat(HAIKU, doubt(1));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.choices[0].message.content, "ok");
  assert.deepEqual(upstreamHits, [HAIKU]);
  assert.equal(await I.isMember("demo", "team"), true, "first use made the student a member");
  await settle();
  const rows = await q("select user_id, model, institute, served_model from usage_events");
  assert.deepEqual(
    rows,
    [{ user_id: "team", model: HAIKU, institute: "demo", served_model: SERVED }],
    "the row names who pays, is priced as the institute's model, and keeps what the provider ran",
  );
  const plan = (await call("GET", "/v1/plan")).json;
  assert.equal(plan.usedUsd, 0, "the institute's calls don't eat the student's own plan");

  // --- the daily cap ------------------------------------------------------------------------------
  await I.putInstitute({ ...I.DEMO, dailyDoubtsPerStudent: 3 });
  assert.equal((await chat(HAIKU, doubt(1))).status, 200, "same doubt again (a follow-up) is fine");
  assert.equal((await chat(HAIKU, doubt(2))).status, 200);
  assert.equal((await chat(HAIKU, doubt(3))).status, 200);
  const capped = await chat(HAIKU, doubt(4));
  assert.equal(capped.status, 429, "the doubt past the cap is refused");
  assert.deepEqual(capped.json, { error: { message: "Daily doubt limit reached", type: "doubt_limit" } });
  assert.equal((await chat(HAIKU, doubt(2))).status, 200, "doubts already asked today keep working");
  assert.equal(await doubtRows(), 3);

  // --- parallel requests at the cap: exactly the cap succeeds -----------------------------------
  await I.putInstitute({ ...I.DEMO, dailyDoubtsPerStudent: 10 }); // 3 used above → 7 left
  const burst = await Promise.all(Array.from({ length: 12 }, (_, n) => chat(HAIKU, doubt(100 + n))));
  assert.equal(burst.filter((r) => r.status === 200).length, 7, "exactly the remaining cap gets through");
  assert.equal(burst.filter((r) => r.status === 429).length, 5);
  assert.equal(await doubtRows(), 10);
  await I.putInstitute(I.DEMO);

  // --- the institute's daily budget: refused BEFORE the provider is called -------------------------
  {
    const hits = upstreamHits.length;
    await I.putInstitute({ ...I.DEMO, dailyBudgetUsd: 0.000001 }); // already spent more than this today
    const broke = await chat(HAIKU, doubt(1));
    assert.equal(broke.status, 429);
    assert.deepEqual(broke.json, { error: { message: "This site has reached today's limit. Try again tomorrow.", type: "institute_budget" } });
    assert.equal(upstreamHits.length, hits, "the over-budget call never reached the provider");
    assert.equal((await chat("anthropic/claude-opus-4.5", doubt(1))).json.error.type, "plan_restricted", "other models: today's rules, not the budget");
    await I.putInstitute({ ...I.DEMO, dailyBudgetUsd: null });
    assert.equal((await chat(HAIKU, doubt(1))).status, 200, "an explicit null budget is unlimited");
    await I.putInstitute(I.DEMO);
  }

  // --- the waived body is cut to what a doubt needs --------------------------------------------
  const before = upstreamHits.length;
  const extras = { max_tokens: 100_000, models: ["anthropic/claude-opus-4.5"], route: "fallback", plugins: [{ id: "web" }], transforms: ["middle-out"], n: 4, reasoning: { effort: "high" }, provider: "openai", temperature: 0.2 };
  const cut = await chat(HAIKU, doubt(1), extras);
  assert.equal(cut.status, 200, "a routing hint on an institute call is ignored, not followed to an unconfigured provider");
  const sent = upstreamBodies.at(-1);
  for (const k of ["models", "route", "plugins", "transforms", "n", "reasoning", "provider"]) assert.ok(!(k in sent), `${k} is not forwarded`);
  assert.equal(sent.max_tokens, 6000, "max_tokens clamped");
  assert.equal(sent.temperature, 0.2, "ordinary sampling settings pass");
  assert.equal(sent.model, HAIKU);
  const pdf = await call("POST", "/v1/chat/completions", { headers: doubt(1), body: { model: HAIKU, messages: [{ role: "user", content: [{ type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" } }] }] } });
  assert.equal(pdf.status, 400, "no PDFs on the institute's bill");
  const huge = await call("POST", "/v1/chat/completions", { headers: doubt(1), body: { model: HAIKU, messages: [{ role: "user", content: "x".repeat(2.5 * 1024 * 1024) }] } });
  assert.equal(huge.status, 413, "waived bodies are capped at 2 MB");
  assert.equal(upstreamHits.length, before + 1, "neither refused call reached the provider");
  // Not waived (own plan) → today's rules, extras untouched by the institute code.
  assert.equal((await chat("anthropic/claude-opus-4.5", doubt(1), extras)).status, 403);
  // ...including the routing hint: made affordable on the student's own plan, a non-waived call
  // still goes where the hint says (openai, unconfigured here → 400), exactly as before.
  process.env.ADA_FREE_MODELS = HAIKU;
  const hinted = await chat(HAIKU, { "x-ada-institute": "demo" }, { provider: "openai" });
  assert.equal(hinted.status, 400);
  assert.match(hinted.json.error.message, /openai/, "the hint is only overridden when the institute pays");
  delete process.env.ADA_FREE_MODELS;

  // --- speech -------------------------------------------------------------------------------------
  const spoken = [];
  S.speechEngine.synth = async (voice, text) => (spoken.push([voice, text]), new Uint8Array([82, 73, 70, 70, text.length]));
  assert.equal((await call("POST", "/v1/tutor/speech", { key: null, body: { text: "hi" } })).status, 401, "signed-in only");
  assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "" } })).status, 400);
  assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "x".repeat(1501) } })).status, 400, "1500 characters max");
  const a = await call("POST", "/v1/tutor/speech", { headers: doubt(1), body: { text: "The answer is four.", voice: "echo" } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("content-type"), "audio/wav");
  assert.equal(a.headers.get("x-ada-cache"), "miss");
  assert.deepEqual([...a.buf], [82, 73, 70, 70, 19]);
  assert.deepEqual(spoken, [["am_michael", "The answer is four."]], "the app's voice map applies");
  const again = await call("POST", "/v1/tutor/speech", { body: { text: " The answer is four. ", voice: "echo" } });
  assert.equal(again.headers.get("x-ada-cache"), "memory", "a repeated line is served from cache");
  assert.equal(spoken.length, 1);
  for (let i = 0; i < 6; i++) {
    assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "The answer is four.", voice: "echo" } })).status, 200, "cache hits are not rate-limited");
  }
  S.speechEngine.synth = async () => {
    throw new Error("model missing");
  };
  const down = await call("POST", "/v1/tutor/speech", { body: { text: "not cached yet" } });
  assert.equal(down.status, 503, "a synth failure is 503 so the client falls back to the browser voice");
  assert.match(down.json.error.message, /model missing/);
  assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "third" } })).status, 503, "3rd synthesis this minute still allowed");
  const limited = await call("POST", "/v1/tutor/speech", { body: { text: "fourth" } });
  assert.equal(limited.status, 429, "past the per-user rate (3 new lines/min in this test)");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "The answer is four.", voice: "echo" } })).status, 200, "a cached line still plays when limited");

  // banned: no voice either
  const { setPlan } = await mod("src/server/plans.ts");
  await setPlan("team", "free", "banned");
  S.speechLimiter.perMinute = 1000;
  assert.equal((await call("POST", "/v1/tutor/speech", { body: { text: "hello" } })).status, 403, "a banned account gets no speech");
  console.log(`ok (${PG ? "postgres" : "sqlite"})`);
} finally {
  server.close();
  fake.close();
  if (PG) await (await mod("src/server/db.ts")).authDatabase().end(); // else the pool keeps the process alive
}
