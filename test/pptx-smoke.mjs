// Smoke test for the .pptx renderer: builds a deck exercising every slide primitive and asserts the
// package is a valid OPC zip whose parts are well-formed XML and contain the expected shapes.
//   run: node --import tsx test/pptx-smoke.mjs
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { buildPptx } = await import(
  pathToFileURL(resolve("src/client/pptx.ts")).href
);

const buf = buildPptx({
  title: "Smoke",
  slides: [
    { title: "Ada", subtitle: "An agent-first code editor" },
    {
      title: "Numbers",
      metrics: [
        { value: "340+", label: "models" },
        { value: "286", label: "skills" },
      ],
      bullets: ["a", "b"],
      notes: "speaker note",
    },
    {
      title: "Chart + bullets",
      chart: {
        data: [
          { label: "Explore", value: 42 },
          { label: "Edit", value: 78 },
        ],
        unit: "k",
      },
      bullets: ["x"],
    },
    {
      title: "Chart only",
      chart: {
        data: [
          { label: "Win", value: 62 },
          { label: "Mac", value: 28 },
        ],
      },
    },
  ],
});

// --- read the zip central directory so we can inspect parts without a zip dependency ---
const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
assert.ok(eocd > 0, "no end-of-central-directory — not a zip");
let off = buf.readUInt32LE(eocd + 16);
const count = buf.readUInt16LE(eocd + 10);
const parts = new Map();
for (let i = 0; i < count; i++) {
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const cmtLen = buf.readUInt16LE(off + 32);
  const method = buf.readUInt16LE(off + 10);
  const csize = buf.readUInt32LE(off + 20);
  const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
  const lho = buf.readUInt32LE(off + 42);
  const lNameLen = buf.readUInt16LE(lho + 26);
  const lExtraLen = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(dataStart, dataStart + csize);
  parts.set(name, method === 8 ? inflateRawSync(raw) : raw);
  off += 46 + nameLen + extraLen + cmtLen;
}

// required package parts
for (const p of [
  "[Content_Types].xml",
  "ppt/presentation.xml",
  "ppt/slides/slide1.xml",
  "ppt/slides/slide4.xml",
]) {
  assert.ok(parts.has(p), `missing part ${p}`);
}

// every xml part must be well-formed enough to have balanced angle brackets and a declaration
for (const [name, data] of parts) {
  if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
  const s = data.toString("utf8");
  assert.ok(s.startsWith("<?xml"), `${name}: missing xml declaration`);
  assert.equal(
    (s.match(/</g) || []).length,
    (s.match(/>/g) || []).length,
    `${name}: unbalanced tags`,
  );
}

const slide2 = parts.get("ppt/slides/slide2.xml").toString("utf8");
const slide3 = parts.get("ppt/slides/slide3.xml").toString("utf8");
const slide4 = parts.get("ppt/slides/slide4.xml").toString("utf8");
assert.equal(
  (slide2.match(/MetricValue/g) || []).length,
  2,
  "expected 2 KPI tiles",
);
assert.equal(
  (slide3.match(/ChartLabel/g) || []).length,
  2,
  "expected 2 chart rows beside bullets",
);
assert.equal(
  (slide4.match(/roundRect/g) || []).length,
  4,
  "expected 2 tracks + 2 bars",
);
assert.ok(
  parts.has("ppt/notesSlides/notesSlide2.xml"),
  "speaker notes part missing",
);

console.log("ok");
