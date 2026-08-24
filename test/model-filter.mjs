// What ada offers, and what it refuses to. Both tests in offerableModel() are evidence-based: an
// entry that publishes no metadata must come through untouched, or the catalogue empties itself the
// day an upstream stops sending a field.
//   run: node --import tsx test/model-filter.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { offerableModel } = await import(pathToFileURL(resolve("src/server/providers/openai-compat.ts")).href);
const { isFreeModel } = await import(pathToFileURL(resolve("src/server/plans.ts")).href);

const priced = { prompt: "0.000003", completion: "0.000015" };
const freeP = { prompt: "0", completion: "0" };

// --- kept ----------------------------------------------------------------------
assert.ok(offerableModel({ supported_parameters: ["tools", "temperature"], pricing: priced }), "priced + tools is the whole point");
assert.ok(offerableModel({}), "no metadata at all must survive — most providers send only an id");
assert.ok(offerableModel({ pricing: priced }), "pricing alone, no parameter list, is not evidence of anything");
assert.ok(offerableModel({ supported_parameters: [], pricing: priced }), "an EMPTY list is 'not stated', not 'stated as none'");
assert.ok(offerableModel({ supported_parameters: ["tools"] }), "tools with no pricing block stays");

// --- dropped: cannot run an agent turn -------------------------------------------
assert.ok(!offerableModel({ supported_parameters: ["max_tokens", "response_format", "seed"], pricing: priced }), "lyria-shaped: no tools");
assert.ok(!offerableModel({ supported_parameters: ["max_tokens", "stop", "temperature"], pricing: priced }), "translation-head shaped: no tools");

// --- dropped: zero-priced shares one per-account, per-minute cap -------------------
assert.ok(!offerableModel({ supported_parameters: ["tools"], pricing: freeP }), "zero-priced, even with tools");
assert.ok(!offerableModel({ pricing: freeP }), "zero-priced with no parameter list");

// A partly-zero price is NOT free — cheap input with paid output still costs money, and treating it
// as free would drop a perfectly good model.
assert.ok(offerableModel({ pricing: { prompt: "0", completion: "0.000015" } }), "free input, paid output is a real model");

// --- the free tier is a price rule, not a suffix ----------------------------------
assert.equal(isFreeModel("google/gemma-4-31b-it:free"), false, "`:free` must not qualify on its suffix any more");
assert.equal(isFreeModel("openrouter/free"), false, "nor on its name");
assert.equal(isFreeModel("definitely/not-a-real-model"), false, "an unknown price fails closed");

// ADA_FREE_MODELS is the remaining escape hatch, and must still work.
process.env.ADA_FREE_MODELS = "some/pinned-model";
assert.equal(isFreeModel("some/pinned-model"), true, "an explicitly pinned id is still free");
delete process.env.ADA_FREE_MODELS;

console.log("ok");
