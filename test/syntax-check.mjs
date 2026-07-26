// A file that fails to parse never runs at all, and nothing at write time used to notice: a
// generated storefront shipped with one missing ")" inside a nested template literal and the whole
// front end was dead while the model reported success. `node --check` costs ~35ms and catches it.
//
// The regression fixture is that exact line.
//   run: node --import tsx test/syntax-check.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { tools } = await import(
  pathToFileURL(resolve("src/client/tools.ts")).href
);
const write = tools.find((t) => t.name === "write_file");
const edit = tools.find((t) => t.name === "edit_file");
const patch = tools.find((t) => t.name === "apply_patch");
process.chdir(mkdtempSync(join(tmpdir(), "sx-")));

// the actual line that broke the generated store: escapeHtml( is opened, then the ${} closes first
const REAL_BUG =
  "const row = (i) => `<span>${i.n} ${i.size ? ` (${esc([i.color].join(', ')})` : ''}</span>`;\n";

// --- a broken file is written, but loudly ---------------------------------------------------
const bad = await write.run({ path: "bad.js", content: REAL_BUG });
assert.match(bad.output, /DOES NOT PARSE/, "a syntax error must be reported");
assert.match(
  bad.output,
  /SyntaxError/,
  "the actual parser message should be included",
);
assert.equal(
  bad.isError,
  true,
  "the model has to notice, so this is an error result",
);
assert.match(
  bad.output,
  /Wrote \d+ bytes/,
  "the file must still be written so it can be fixed",
);

// --- the fixed version is silent ------------------------------------------------------------
const good = await write.run({
  path: "good.js",
  content:
    "const row = (i) => `<span>${i.n} ${i.size ? ` (${esc([i.color].join(', '))})` : ''}</span>`;\n",
});
assert.doesNotMatch(
  good.output,
  /PARSE|SyntaxError/,
  `valid js must not be flagged: ${good.output}`,
);
assert.notEqual(good.isError, true);

// --- dialects node can't parse are not treated as failures ---------------------------------
const jsx = await write.run({
  path: "comp.js",
  content: "const C = () => <div className='x'>hi</div>;\nexport default C;\n",
});
assert.doesNotMatch(
  jsx.output,
  /DOES NOT PARSE/,
  "JSX in a .js is legitimate — must not be called broken",
);
assert.notEqual(jsx.isError, true, "JSX must not fail the write");
assert.match(
  jsx.output,
  /likely JSX/,
  "but it should say why node couldn't parse it",
);

// browser ESM and top-level await are real JS and must pass clean
for (const [name, src] of [
  ["esm.js", "import x from './y.js';\nexport const z = x;\n"],
  ["tla.js", "export const a = 1;\nawait Promise.resolve();\n"],
]) {
  const r = await write.run({ path: name, content: src });
  assert.doesNotMatch(
    r.output,
    /PARSE|JSX/,
    `${name} is valid modern JS: ${r.output}`,
  );
}

// TypeScript is checked by lsp_diagnostics, not here — node can't parse it and mustn't try
const ts = await write.run({
  path: "t.ts",
  content: "interface A { b: string }\nexport const c: A = { b: 'x' };\n",
});
assert.doesNotMatch(
  ts.output,
  /PARSE|JSX/,
  `.ts must be skipped entirely: ${ts.output}`,
);

// non-JS is never checked
const css = await write.run({ path: "s.css", content: "body { color: red;\n" });
assert.doesNotMatch(css.output, /PARSE/, "css is not javascript");

// --- editing valid code INTO broken code is caught too -------------------------------------
writeFileSync("live.js", "const a = 1;\nconst b = 2;\n");
const broke = await edit.run({
  path: "live.js",
  old_text: "const b = 2;",
  new_text: "const b = (2;",
});
assert.match(broke.output, /DOES NOT PARSE/, "edit_file must check its result");
assert.equal(broke.isError, true);

// --- apply_patch, both actions -------------------------------------------------------------
const added = await patch.run({
  files: [{ path: "patched.js", action: "create", content: REAL_BUG }],
});
assert.match(added.output, /DOES NOT PARSE/, "apply_patch create must check");
assert.equal(added.isError, true, "a broken file makes the patch an error");

writeFileSync("upd.js", "const ok = 1;\n");
const updated = await patch.run({
  files: [
    {
      path: "upd.js",
      action: "update",
      edits: [{ old_text: "const ok = 1;", new_text: "const ok = (1;" }],
    },
  ],
});
assert.match(updated.output, /DOES NOT PARSE/, "apply_patch update must check");

// --- and it can be turned off ---------------------------------------------------------------
process.env.ADA_NO_SYNTAX_CHECK = "1";
const off = await write.run({ path: "off.js", content: REAL_BUG });
assert.doesNotMatch(
  off.output,
  /DOES NOT PARSE/,
  "ADA_NO_SYNTAX_CHECK should disable it",
);
delete process.env.ADA_NO_SYNTAX_CHECK;

console.log("ok");
