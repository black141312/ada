// create_page's job beyond write_file is the self-containment contract: a page that needs a CDN
// isn't a file you can send anyone. Guards the rejection, the soft warning, and where files land.
//   run: node --import tsx test/create-page.mjs
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { tools } = await import(pathToFileURL(resolve("src/client/tools.ts")).href);
const page = tools.find((t) => t.name === "create_page");
assert.ok(page, "create_page is not registered");
assert.equal(page.lazy, true, "create_page must be gated — its schema shouldn't ride every request");

const body = (extra = "") => `<!doctype html><html><head><title>T</title>${extra}
<style>:root{--a:#3fb950}body{font-family:system-ui;color:var(--a)}</style></head>
<body><h1>A real page</h1><p>${"Long enough to clear the stub check. ".repeat(6)}</p></body></html>`;

const dir = mkdtempSync(join(tmpdir(), "page-"));
process.chdir(dir);

// --- rejected: anything the page must fetch to render ---
for (const [what, extra] of [
  ["CDN script", '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>'],
  ["webfont link", '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'],
  ["protocol-relative script", '<script src="//unpkg.com/x"></script>'],
  ["css @import", "<style>@import url(https://fonts.googleapis.com/css2);</style>"],
]) {
  const r = await page.run({ path: "x.html", html: body(extra), open: false });
  assert.ok(r.isError, `${what} should be rejected`);
  assert.match(r.output, /off the network/, `${what}: unhelpful message`);
}

// --- warned, not blocked: a remote image degrades to alt text ---
const img = await page.run({ path: "img.html", html: body('<img src="https://example.com/a.png" alt="a">'), open: false });
assert.ok(!img.isError, "a remote image must not block the write");
assert.match(img.output, /Heads up/, "a remote image should still be called out");

// --- accepted: inline everything, including a data: URI image ---
const ok = await page.run({
  path: "report.html",
  html: body('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="dot">'),
  open: false,
});
assert.ok(!ok.isError, ok.output);
const m = ok.output.match(/Open it here: (.+)/);
assert.ok(m, "must print the absolute path");
assert.ok(existsSync(m[1].trim()), "file not written");
assert.ok(m[1].includes("docs"), "a bare filename should land in docs/");
assert.match(readFileSync(m[1].trim(), "utf8"), /A real page/);

// --- an explicit path is honoured as given ---
const at = await page.run({ path: "sub/dir/out.html", html: body(), open: false });
assert.ok(!at.isError, at.output);
assert.ok(!/docs/.test(at.output.match(/Open it here: (.+)/)[1]), "an explicit path must not be moved to docs/");

// --- rubbish in, clear error out ---
assert.ok((await page.run({ path: "a.txt", html: body(), open: false })).isError, ".txt should be refused");
assert.ok((await page.run({ path: "b.html", html: "<p>hi</p>", open: false })).isError, "a stub should be refused");

console.log("ok");
