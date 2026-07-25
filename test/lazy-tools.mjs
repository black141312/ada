// The document/image tools carry big schemas that are resent on EVERY request, so they're only
// advertised when the conversation asks for that kind of output. This guards both halves: the
// intent gate's accuracy, and that gating actually removes the tokens.
//   run: node --import tsx test/lazy-tools.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { tools } = await import(
  pathToFileURL(resolve("src/client/tools.ts")).href
);

// Read the regex out of the implementation so this test can never drift from it.
const src = readFileSync("src/client/agent.ts", "utf8");
const m = src.match(/const LAZY_INTENT =\s*\n?\s*\/(.+)\/i;/);
assert.ok(m, "LAZY_INTENT regex not found in agent.ts");
const intent = new RegExp(m[1], "i");

const lazy = tools.filter((t) => t.lazy).map((t) => t.name);
assert.deepEqual(
  lazy.sort(),
  ["generate_docx", "generate_image", "generate_pptx"],
  "unexpected set of lazy tools",
);

// Gating must actually save a meaningful number of tokens, or it isn't worth the complexity.
const est = (x) => Math.ceil(JSON.stringify(x).length / 4);
const shape = (t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
});
const all = est(tools.map(shape));
const lean = est(tools.filter((t) => !t.lazy).map(shape));
assert.ok(
  all - lean > 700,
  `gating should save >700 tokens, saved ${all - lean}`,
);

// Ordinary coding chatter must NOT drag in the document tools.
for (const s of [
  "hi",
  "thanks",
  "fix the failing test",
  "what does this repo do?",
  "refactor the auth module",
  "add a button to settings",
  "run the tests",
  "deploy to prod",
  "ship the release",
]) {
  assert.equal(intent.test(s), false, `should not trigger lazy tools: "${s}"`);
}

// Anything that asks for a deck, document or picture must enable them.
for (const s of [
  "make me a deck about this project",
  "make a ppt for this",
  "turn this into slides",
  "create a pptx summary",
  "write a word document explaining the architecture",
  "create a word file",
  "can you produce a report on our api?",
  "generate an image of a robot",
  "draw a diagram of the flow",
  "design a thumbnail",
]) {
  assert.equal(intent.test(s), true, `should trigger lazy tools: "${s}"`);
}

console.log("ok");
