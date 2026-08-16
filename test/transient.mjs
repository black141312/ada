import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { APIConnectionError, APIConnectionTimeoutError } from "openai";
const { isTransient } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);

// The errors the SDK actually throws — built here, not hand-written, so a wording change upstream
// fails this instead of silently turning retries back off.
assert.equal(isTransient(new APIConnectionError({ cause: new Error("socket hang up") })), true,
  "APIConnectionError is the common drop — retrying it is the whole point");
assert.equal(isTransient(new APIConnectionTimeoutError()), true);

// raw network failures, as undici words them
for (const m of ["TypeError: fetch failed", "TypeError: terminated", "read ECONNRESET",
                 "getaddrinfo ENOTFOUND openrouter.ai", "getaddrinfo EAI_AGAIN openrouter.ai"])
  assert.equal(isTransient(new Error(m)), true, m);

// server-side transients, by status
for (const status of [408, 429, 500, 502, 503, 504, 529])
  assert.equal(isTransient(Object.assign(new Error("upstream"), { status })), true, String(status));

// a retry cannot help these — asking twice gets the same no, and costs a second call
for (const e of [Object.assign(new Error("401 Unauthorized"), { status: 401 }),
                 Object.assign(new Error("402 insufficient credit"), { status: 402 }),
                 Object.assign(new Error("400 invalid model"), { status: 400 }),
                 new Error("context length exceeded")])
  assert.equal(isTransient(e), false, e.message);

// non-Error values must not throw
assert.equal(isTransient("boom"), false);
assert.equal(isTransient(undefined), false);
console.log("ok");
