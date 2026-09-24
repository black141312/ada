// /v1/chat/completions body-size cap: a request over 40 MB must 413 before anything downstream
// (JSON parsing, model lookup, provider dispatch) ever sees it. Same createAdaServer() harness as
// test/classes-api.mjs.
//   run: node --import tsx test/chat-body-cap.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-chat-body-cap-"));
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

const server = createAdaServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const post = async (body) => {
  const res = await fetch(origin + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${alice}`, "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
};

try {
  // Under the cap: the request reaches handleChat's own validation (no model → 400), proving the
  // size check does not reject ordinary bodies.
  const under = (await post(JSON.stringify({ messages: [] }))).status;
  assert.equal(under, 400, "a normal small body clears the cap and reaches model validation");

  // Over the 40 MB cap: rejected with 413 and a JSON error, before JSON.parse or model validation
  // ever runs (a body this size wouldn't parse as the tiny object it wraps if it got that far).
  const bigPad = "x".repeat(41 * 1024 * 1024);
  const { status, json } = await post(`{"model":"gpt-4","messages":[{"role":"user","content":"${bigPad}"}]}`);
  assert.equal(status, 413, "a 41 MB body is rejected with 413");
  assert.equal(json.error.message, "request body too large (40 MB cap)", "the error names the cap");

  console.log("ok");
} finally {
  server.close();
}
