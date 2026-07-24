// Smoke test for the .docx renderer: builds a document using every block type and asserts the
// package is a valid OPC zip whose parts are well-formed and contain the expected WordprocessingML.
//   run: node --import tsx test/docx-smoke.mjs
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { buildDocx } = await import(
  pathToFileURL(resolve("src/client/docx.ts")).href
);

const buf = buildDocx({
  title: "Ada",
  subtitle: "An agent-first code editor",
  blocks: [
    { type: "heading", text: "Overview", level: 1 },
    { type: "paragraph", text: "Ada runs the agent locally.", bold: false },
    {
      type: "bullets",
      items: ["Local context engineering", { text: "Nested detail", level: 1 }],
    },
    {
      type: "numbered",
      items: ["Open a folder", "Describe the change", "Review the branch"],
    },
    { type: "heading", text: "Comparison", level: 2 },
    {
      type: "table",
      headers: ["Platform", "Auto-update"],
      rows: [
        ["Windows", "yes"],
        ["macOS", "yes"],
      ],
    },
    { type: "pageBreak" },
    { type: "paragraph", text: "Appendix." },
  ],
});

// --- read the zip central directory (no zip dependency) ---
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
  const dataStart =
    lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.subarray(dataStart, dataStart + csize);
  parts.set(name, method === 8 ? inflateRawSync(raw) : raw);
  off += 46 + nameLen + extraLen + cmtLen;
}

for (const p of [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/document.xml",
  "word/styles.xml",
  "word/numbering.xml",
]) {
  assert.ok(parts.has(p), `missing part ${p}`);
}

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

const doc = parts.get("word/document.xml").toString("utf8");
assert.ok(doc.includes('<w:pStyle w:val="Title"/>'), "title style missing");
assert.ok(doc.includes('<w:pStyle w:val="Heading1"/>'), "heading 1 missing");
assert.ok(doc.includes('<w:pStyle w:val="Heading2"/>'), "heading 2 missing");
assert.ok(doc.includes('<w:numId w:val="1"/>'), "bullet list missing");
assert.ok(doc.includes('<w:numId w:val="2"/>'), "numbered list missing");
assert.ok(doc.includes('<w:ilvl w:val="1"/>'), "nested bullet level missing");
assert.ok(doc.includes("<w:tbl>"), "table missing");
assert.ok(doc.includes('<w:br w:type="page"/>'), "page break missing");
assert.ok(doc.includes("<w:sectPr>"), "section properties missing");
// XML-escaping must survive user text
const esc = buildDocx({
  blocks: [{ type: "paragraph", text: 'a & b < c > "d"' }],
}).toString("latin1");
assert.ok(!/a & b/.test(esc), "raw ampersand leaked into the XML");

console.log("ok");
