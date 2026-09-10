// /v1/audio/speech: the request shape is validated before a byte goes upstream. run:
//   node --import tsx test/speech.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { buildSpeechRequest, SPEECH_MODEL, SPEECH_MAX_CHARS } = await import(pathToFileURL(resolve("src/server/speech.ts")).href);

const ok = buildSpeechRequest({ input: "Hello", voice: "nova" });
assert.deepEqual(ok, { ok: true, input: "Hello", voice: "nova", model: SPEECH_MODEL, response_format: "mp3" });

// defaults + trimming
assert.equal(buildSpeechRequest({ input: "  hi  " }).voice, "nova");
assert.equal(buildSpeechRequest({ input: "  hi  " }).input, "hi");

// unknown voice → default rather than a 400 (the client's list may lag the provider's)
assert.equal(buildSpeechRequest({ input: "x", voice: "robot9000" }).voice, "nova");

// the caller cannot pick the model or format — one priced model, one container
assert.equal(buildSpeechRequest({ input: "x", model: "tts-1-hd", response_format: "wav" }).model, SPEECH_MODEL);
assert.equal(buildSpeechRequest({ input: "x", response_format: "wav" }).response_format, "mp3");

// rejections
assert.deepEqual(buildSpeechRequest(null), { ok: false, status: 400, message: "invalid JSON body" });
assert.deepEqual(buildSpeechRequest({}), { ok: false, status: 400, message: "missing 'input'" });
assert.deepEqual(buildSpeechRequest({ input: "   " }), { ok: false, status: 400, message: "missing 'input'" });
const long = buildSpeechRequest({ input: "a".repeat(SPEECH_MAX_CHARS + 1) });
assert.equal(long.ok, false);
assert.equal(long.status, 413);
console.log("ok");
