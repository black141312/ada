import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { explainApiError } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);

// what OpenRouter actually sends when the upstream provider rejects a request
const or = Object.assign(new Error("400 Provider returned error"), {
  error: { message: "Provider returned error", code: 400,
    metadata: { provider_name: "InclusionAI", raw: JSON.stringify({ error: { message: "input token count exceeds the per-request limit" } }) } },
});
assert.equal(explainApiError(or).message,
  "400 Provider returned error (provider: InclusionAI): input token count exceeds the per-request limit");

// raw that isn't JSON is shown verbatim
const plain = Object.assign(new Error("400 Provider returned error"), {
  error: { metadata: { provider_name: "Chutes", raw: "upstream 503 backend unavailable" } },
});
assert.match(explainApiError(plain).message, /\(provider: Chutes\): upstream 503 backend unavailable$/);

// an ordinary error is passed through untouched
const bare = new Error("401 Unauthorized");
assert.equal(explainApiError(bare).message, "401 Unauthorized");
assert.equal(explainApiError(bare), bare);

// non-Error values must not throw
assert.equal(explainApiError("boom"), "boom");
assert.equal(explainApiError(undefined), undefined);
console.log("ok");
