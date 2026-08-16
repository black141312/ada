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

// Import the gates rather than re-deriving them, so this test can never drift from what ships.
// SMALL_TALK is still scraped from source below.
const src = readFileSync("src/client/agent.ts", "utf8");
const { LAZY_GATES: GATES } = await import(
  pathToFileURL(resolve("src/client/agent.ts")).href
);
assert.equal(GATES.length, 5, `expected 5 gate groups, got ${GATES.length}`);
const gateFor = (name) => GATES.find((g) => g.tools.includes(name));

// `browse` is registered at runtime (browse.ts, from registerSubagentTools) so it isn't in this
// static list — its gate is checked below by name instead.
const lazy = tools.filter((t) => t.lazy).map((t) => t.name);
assert.deepEqual(
  lazy.sort(),
  [
    "convert_image",
    "create_page",
    "generate_docx",
    "generate_image",
    "generate_pptx",
    "notebook_edit",
    "ui_ux_search",
  ],
  "unexpected set of lazy tools",
);

// Every gate must carry real word boundaries. A literal backspace byte (0x08) reads as "\b" in a
// stringified regex but matches nothing — it has slipped in more than once when a gate was written
// through a shell, and the symptom is a tool that is simply never offered.
for (const g of GATES) {
  assert.ok(
    !g.intent.source.includes(String.fromCharCode(8)),
    `gate for ${g.tools.join("/")} contains a raw backspace byte instead of a word boundary`,
  );
}
// A lazy tool with no gate could never be advertised — fail here rather than in production.
for (const name of lazy) {
  assert.ok(
    gateFor(name),
    `lazy tool "${name}" has no entry in LAZY_GATES — it would be invisible`,
  );
}

// The doc gate is the one that fires most; it must not drag the others in with it.
const docIntent = gateFor("generate_pptx").intent;
const nbIntent = gateFor("notebook_edit").intent;
const browserIntent = gateFor("browse").intent;
assert.equal(
  nbIntent.test("make me a deck about this project"),
  false,
  "a deck request must not enable the notebook tool",
);
assert.equal(
  browserIntent.test("make me a deck about this project"),
  false,
  "a deck request must not enable the browser tool",
);
assert.equal(
  docIntent.test("fix the failing cell in analysis.ipynb"),
  false,
  "a notebook request must not enable the document tools",
);

for (const s of [
  "edit the second cell of analysis.ipynb",
  "this jupyter notebook is broken",
  "add a markdown cell explaining the model",
]) {
  assert.equal(nbIntent.test(s), true, `should enable notebook_edit: "${s}"`);
}
for (const s of [
  "screenshot the settings page",
  "check the console for errors",
  "open http://localhost:5173 and look",
  "does the page render?",
]) {
  assert.equal(browserIntent.test(s), true, `should enable browser: "${s}"`);
}
for (const s of [
  "fix the failing test",
  "refactor the auth module",
  "rename this variable",
]) {
  assert.equal(
    nbIntent.test(s) || browserIntent.test(s),
    false,
    `plain coding must enable neither: "${s}"`,
  );
}

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
  assert.equal(
    docIntent.test(s),
    false,
    `should not trigger the document tools: "${s}"`,
  );
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
  assert.equal(
    docIntent.test(s),
    true,
    `should trigger the document tools: "${s}"`,
  );
}

// --- the repo map is skipped for small talk, but must ride along for anything real ---
const sm = src.match(/const SMALL_TALK =\s*\n?\s*\/(.+)\/i;/);
assert.ok(sm, "SMALL_TALK regex not found in agent.ts");
const smallTalk = new RegExp(sm[1], "i");
const skipsMap = (t) => t.trim().length <= 40 && smallTalk.test(t.trim());

for (const s of [
  "hi",
  "hey",
  "hello!",
  "thanks",
  "thank you",
  "ok",
  "cool",
  "got it",
  "good morning",
  "bye",
]) {
  assert.equal(
    skipsMap(s),
    true,
    `small talk should skip the repo map: "${s}"`,
  );
}
// Anything with actual intent keeps the map — including messages that merely START with a greeting.
for (const s of [
  "hey can you fix the auth bug?",
  "hi, what does this project do?",
  "fix the failing test",
  "what is this repo?",
  "add a settings toggle",
  "thanks — now refactor the parser",
  "ok now deploy it",
]) {
  assert.equal(
    skipsMap(s),
    false,
    `real request must keep the repo map: "${s}"`,
  );
}

const pageIntent = gateFor("create_page").intent;
for (const t of [
  "build me an html page for this",
  "make a dashboard",
  "write this up as a one-pager",
  "a shareable page please",
]) {
  assert.equal(pageIntent.test(t), true, `should enable create_page: "${t}"`);
}
for (const t of [
  "fix the failing test",
  "refactor the auth module",
  "run the tests",
]) {
  assert.equal(
    pageIntent.test(t),
    false,
    `plain coding must not enable create_page: "${t}"`,
  );
}
assert.equal(
  nbIntent.test("make a dashboard"),
  false,
  "a page request must not enable the notebook tool",
);

// Format-ambiguous wording must unlock BOTH generators, or the agent cannot offer the choice it is
// told to offer. Unambiguous wording must stay narrow so a "deck" request doesn't drag the page tool in.
const pageIntent2 = gateFor("create_page").intent;
for (const t of [
  "create a presentation for the project",
  "write it up as a report",
]) {
  assert.equal(
    docIntent.test(t) && pageIntent2.test(t),
    true,
    `ambiguous wording should offer both: "${t}"`,
  );
}
for (const [t, deck, page] of [
  ["make me a deck", true, false],
  ["turn this into slides", true, false],
  ["build an html page", false, true],
  ["give me a one-pager", false, true],
]) {
  assert.equal(docIntent.test(t), deck, `deck gate wrong for "${t}"`);
  assert.equal(pageIntent2.test(t), page, `page gate wrong for "${t}"`);
}
// and both tools must actually carry the instruction to ask
for (const n of ["generate_pptx", "create_page"]) {
  const d = tools.find((x) => x.name === n).description;
  assert.match(
    d,
    /ask_user first which they want/,
    `${n} should tell the agent to ask when the format is ambiguous`,
  );
}

console.log("ok");
