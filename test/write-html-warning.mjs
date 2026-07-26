// A webfont link is the one external reference that fails *silently*: the page looks right on the
// machine that made it and falls back to a different stack for everyone offline. create_page refuses
// outright; write_file is general-purpose, so it warns instead. Regression fixture is the real
// portfolio Ada shipped with fonts.googleapis.com in it.
//   run: node --import tsx test/write-html-warning.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { tools } = await import(
  pathToFileURL(resolve("src/client/tools.ts")).href
);
const write = tools.find((t) => t.name === "write_file");
process.chdir(mkdtempSync(join(tmpdir(), "wf-")));

const page = (head = "") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body><h1>hi</h1></body></html>`;

// the exact shape Ada shipped
const fonts = await write.run({
  path: "portfolio.html",
  content: page(
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
  ),
});
assert.ok(
  !fonts.isError,
  "write_file must still write the file — this is a warning, not a refusal",
);
assert.match(
  fonts.output,
  /won't stand alone/,
  "should warn that the page needs the network",
);
assert.match(fonts.output, /webfont/, "should name the webfont specifically");
assert.match(
  fonts.output,
  /system font stack|data: URI/,
  "should say what to do instead",
);

// other external refs warn too, with their own wording
const cdn = await write.run({
  path: "cdn.html",
  content: page('<script src="https://cdn.jsdelivr.net/npm/x"></script>'),
});
assert.match(
  cdn.output,
  /external script\/stylesheet/,
  "should flag a CDN script",
);
const img = await write.run({
  path: "img.html",
  content: page().replace(
    "<h1>hi</h1>",
    '<img src="https://example.com/a.png" alt="a">',
  ),
});
assert.match(img.output, /remote image/, "should flag a remote image");

// a self-contained page says nothing extra
const clean = await write.run({
  path: "clean.html",
  content: page("<style>body{font-family:system-ui}</style>"),
});
assert.doesNotMatch(
  clean.output,
  /stand alone/,
  "a self-contained page should draw no warning",
);

// and non-HTML is never inspected — a .ts file full of URLs is not a broken page
const ts = await write.run({
  path: "a.ts",
  content: 'const u = "https://fonts.googleapis.com/css2";\n',
});
assert.doesNotMatch(
  ts.output,
  /stand alone/,
  "only .html/.htm should be checked",
);

console.log("ok");
