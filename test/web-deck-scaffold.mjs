// The web-deck skill ships a scaffold the agent copies verbatim. If someone trims it, decks quietly
// lose the parts that make them decks — clamping at the ends, hidden slides staying hidden from
// screen readers, and each slide printing as its own page.
//   run: node --import tsx test/web-deck-scaffold.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// tolerate CRLF, and whatever quote style the formatter settles on
const md = readFileSync("skills/web-deck/SKILL.md", "utf8").replace(
  /\r\n/g,
  "\n",
);
const js = md.match(/```js\n([\s\S]*?)```/)?.[1];
const css = md.match(/```css\n([\s\S]*?)```/)?.[1];
assert.ok(js && css, "the scaffold's js and css blocks must both be present");

for (const [what, re] of [
  ["clamps at both ends", /Math\.max\(0,\s*Math\.min\(slides\.length - 1/],
  ["ArrowRight advances", /ArrowRight/],
  ["ArrowLeft goes back", /ArrowLeft/],
  ["Home jumps to the first slide", /["']Home["']/],
  ["End jumps to the last", /["']End["']/],
  ["hides slides from screen readers", /aria-hidden/],
  ["keeps a counter", /padStart\(2,\s*["']0["']\)/],
  ["deep-links by hash", /hashchange/],
]) {
  assert.match(js, re, `scaffold js lost: ${what}`);
}

for (const [what, re] of [
  ["one slide per screen", /\.deck\s*\{[\s\S]*?height:\s*100vh/],
  [
    "only the active slide visible",
    /\.slide\.on\s*\{[\s\S]*?visibility:\s*visible/,
  ],
  ["respects reduced motion", /prefers-reduced-motion/],
  ["prints one slide per page", /@media print[\s\S]*break-after:\s*page/],
]) {
  assert.match(css, re, `scaffold css lost: ${what}`);
}

// non-presentation work must be sent elsewhere, or every page turns into a deck
assert.match(
  md,
  /web-page/,
  "should point report/dashboard work at the web-page skill",
);

// and create_page must mention it, or the agent never loads it
const tools = readFileSync("src/client/tools.ts", "utf8");
assert.match(
  tools,
  /`web-deck` when it's a presentation/,
  "create_page should route presentations to web-deck",
);

console.log("ok");
