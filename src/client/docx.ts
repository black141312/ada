// Zero-dependency .docx writer — the Word counterpart to pptx.ts. A model emits structured JSON
// blocks and gets a real, editable Word document: headings, paragraphs, bullet/numbered lists,
// tables, images and page breaks. A .docx is an OPC zip of WordprocessingML parts; we generate the
// minimal valid set (content types, package rels, document, styles, numbering, media).

import { readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { EMU, IMAGE_TYPES, XML_DECL, esc, imageSize, relsXml, zip } from "./ooxml.ts";

export interface DocxTable {
  headers?: string[];
  rows: string[][];
}

/** One block of the document, discriminated by `type` so weak models can't mis-shape it. */
export type DocxBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string; bold?: boolean; italic?: boolean }
  | { type: "bullets"; items: (string | { text: string; level?: number })[] }
  | { type: "numbered"; items: string[] }
  | { type: "table"; headers?: string[]; rows: string[][] }
  | { type: "image"; path: string; width?: number } // width in inches (default 6)
  | { type: "pageBreak" };

export interface DocxSpec {
  title?: string; // rendered as the document title, and set in document properties
  subtitle?: string;
  author?: string;
  blocks: DocxBlock[];
}

// ---------------------------------------------------------------------------
// WordprocessingML fragments. Word measures text in half-points and layout in twips (1/1440 in).

const W_NS =
  `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

const COLOR = { heading: "1A2536", body: "24292F", accent: "4472C4", muted: "5F6368" };
const NUM_BULLET = 1; // numId in numbering.xml
const NUM_ORDERED = 2;

/** A run of text with optional emphasis. */
function run(text: string, o: { sz?: number; bold?: boolean; italic?: boolean; color?: string } = {}): string {
  const props =
    `<w:rPr>` +
    (o.bold ? `<w:b/>` : "") +
    (o.italic ? `<w:i/>` : "") +
    (o.color ? `<w:color w:val="${o.color}"/>` : "") +
    (o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : "") +
    `</w:rPr>`;
  // xml:space="preserve" keeps leading/trailing spaces Word would otherwise trim
  return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function paragraph(runs: string, opts: { style?: string; numId?: number; level?: number; spaceAfter?: number; align?: "center" } = {}): string {
  const pPr =
    `<w:pPr>` +
    (opts.style ? `<w:pStyle w:val="${opts.style}"/>` : "") +
    (opts.numId ? `<w:numPr><w:ilvl w:val="${opts.level ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>` : "") +
    (opts.align ? `<w:jc w:val="${opts.align}"/>` : "") +
    `<w:spacing w:after="${opts.spaceAfter ?? 120}"/>` +
    `</w:pPr>`;
  return `<w:p>${pPr}${runs}</w:p>`;
}

function tableXml(t: DocxTable): string {
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const cols = Math.max(t.headers?.length ?? 0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
  const cellW = Math.floor(9360 / cols); // usable page width in twips (8.5in - 1in margins)
  const cell = (text: string, header: boolean): string =>
    `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/>` +
    (header ? `<w:shd w:val="clear" w:fill="EEF2F8"/>` : "") +
    `</w:tcPr>${paragraph(run(String(text ?? ""), { sz: 20, bold: header, color: header ? COLOR.heading : COLOR.body }), { spaceAfter: 0 })}</w:tc>`;
  const borders =
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D5DBE3"/>`).join("") +
    `</w:tblBorders>`;
  const head = t.headers?.length ? `<w:tr>${t.headers.map((h) => cell(h, true)).join("")}</w:tr>` : "";
  const body = rows.map((r) => `<w:tr>${Array.from({ length: cols }, (_, i) => cell((r ?? [])[i] ?? "", false)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${head}${body}</w:tbl>`;
}

function imageXml(relId: string, cx: number, cy: number, id: number): string {
  return (
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Image ${id}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Image ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

function stylesXml(): string {
  const style = (id: string, name: string, sz: number, color: string, bold: boolean, before: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${id === "Title" ? 0 : Number(id.slice(-1)) - 1}"/></w:pPr>` +
    `<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>${bold ? "<w:b/>" : ""}<w:color w:val="${color}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  return (
    `${XML_DECL}<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:color w:val="${COLOR.body}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    style("Title", "Title", 56, COLOR.heading, true, 0) +
    style("Heading1", "heading 1", 36, COLOR.heading, true, 320) +
    style("Heading2", "heading 2", 28, COLOR.heading, true, 280) +
    style("Heading3", "heading 3", 24, COLOR.accent, true, 240) +
    `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="${COLOR.muted}"/><w:sz w:val="26"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

/** Two lists: bullets (with nesting) and a decimal ordered list. */
function numberingXml(): string {
  const bulletLvls = Array.from({ length: 5 }, (_, i) => {
    const char = i % 2 ? "o" : "•";
    return (
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${char}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>`
    );
  }).join("");
  const orderedLvls = Array.from({ length: 5 }, (_, i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`,
  ).join("");
  return (
    `${XML_DECL}<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLvls}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${orderedLvls}</w:abstractNum>` +
    `<w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="1"/></w:num>` +
    `<w:num w:numId="${NUM_ORDERED}"><w:abstractNumId w:val="2"/></w:num>` +
    `</w:numbering>`
  );
}

// ---------------------------------------------------------------------------

export function buildDocx(spec: DocxSpec, cwd = process.cwd()): Buffer {
  const raw = spec.blocks ?? [];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("generate_docx: `blocks` must be a non-empty array of block objects");
  if (raw.length > 2000) throw new Error("generate_docx: too many blocks (max 2000)");

  const entries: { name: string; data: Buffer }[] = [];
  const rels: { id: string; type: string; target: string }[] = [
    { id: "rId1", type: "styles", target: "styles.xml" },
    { id: "rId2", type: "numbering", target: "numbering.xml" },
  ];
  const body: string[] = [];
  const usedImageExts = new Set<string>();
  let media = 0;
  let nextRel = 3;
  let drawingId = 1;

  if (spec.title) body.push(paragraph(run(spec.title), { style: "Title" }));
  if (spec.subtitle) body.push(paragraph(run(spec.subtitle), { style: "Subtitle" }));

  raw.forEach((b, i) => {
    const blk = (typeof b === "string" ? { type: "paragraph", text: b } : (b ?? {})) as DocxBlock;
    switch (blk.type) {
      case "heading": {
        const lvl = Math.min(Math.max(Number(blk.level) || 1, 1), 3);
        body.push(paragraph(run(String(blk.text ?? "")), { style: `Heading${lvl}` }));
        break;
      }
      case "paragraph":
        body.push(paragraph(run(String(blk.text ?? ""), { bold: blk.bold, italic: blk.italic })));
        break;
      case "bullets": {
        const items = Array.isArray(blk.items) ? blk.items : [];
        for (const it of items) {
          const text = typeof it === "string" ? it : String(it?.text ?? "");
          const level = Math.min(Math.max(typeof it === "string" ? 0 : Number(it?.level) || 0, 0), 4);
          body.push(paragraph(run(text), { numId: NUM_BULLET, level, spaceAfter: 60 }));
        }
        break;
      }
      case "numbered": {
        const items = Array.isArray(blk.items) ? blk.items : [];
        for (const it of items) body.push(paragraph(run(String(it ?? "")), { numId: NUM_ORDERED, spaceAfter: 60 }));
        break;
      }
      case "table":
        body.push(tableXml({ headers: blk.headers, rows: blk.rows }));
        body.push(paragraph("", { spaceAfter: 160 })); // Word needs a paragraph after a table
        break;
      case "image": {
        const p = String(blk.path ?? "");
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        const kind = IMAGE_TYPES[extname(abs).toLowerCase()];
        if (!kind) throw new Error(`generate_docx: block ${i + 1}: unsupported image type "${extname(abs)}" (png/jpg/gif)`);
        const data = readFileSync(abs); // clear ENOENT if missing
        media++;
        const ext = kind === "jpeg" ? "jpeg" : kind;
        usedImageExts.add(ext);
        entries.push({ name: `word/media/image${media}.${ext}`, data });
        const relId = `rId${nextRel++}`;
        rels.push({ id: relId, type: "image", target: `media/image${media}.${ext}` });
        const nat = imageSize(data, kind);
        const maxW = Math.round((Number(blk.width) > 0 ? Number(blk.width) : 6) * EMU);
        const cx = maxW;
        const cy = nat && nat.w > 0 ? Math.round((nat.h / nat.w) * maxW) : Math.round(maxW * 0.6);
        body.push(imageXml(relId, cx, cy, drawingId++));
        break;
      }
      case "pageBreak":
        body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
        break;
      default:
        throw new Error(`generate_docx: block ${i + 1}: unknown type "${(blk as { type?: string }).type}" (heading|paragraph|bullets|numbered|table|image|pageBreak)`);
    }
  });

  // Letter page with 1" margins.
  const sectPr = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  entries.push({ name: "word/document.xml", data: Buffer.from(`${XML_DECL}<w:document ${W_NS}><w:body>${body.join("")}${sectPr}</w:body></w:document>`, "utf8") });
  entries.push({ name: "word/styles.xml", data: Buffer.from(stylesXml(), "utf8") });
  entries.push({ name: "word/numbering.xml", data: Buffer.from(numberingXml(), "utf8") });
  entries.push({ name: "word/_rels/document.xml.rels", data: Buffer.from(relsXml(rels), "utf8") });

  const defaults = [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    ...[...usedImageExts].map((e) => `<Default Extension="${e}" ContentType="image/${e === "jpeg" ? "jpeg" : e}"/>`),
  ].join("");
  entries.push({
    name: "[Content_Types].xml",
    data: Buffer.from(
      `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
        `</Types>`,
      "utf8",
    ),
  });
  entries.push({
    name: "_rels/.rels",
    data: Buffer.from(
      relsXml([
        { id: "rId1", type: "officeDocument", target: "word/document.xml" },
        { id: "rId2", type: "metadata/core-properties", target: "docProps/core.xml" },
      ]),
      "utf8",
    ),
  });
  entries.push({
    name: "docProps/core.xml",
    data: Buffer.from(
      `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:title>${esc(spec.title ?? "Document")}</dc:title><dc:creator>${esc(spec.author ?? "ada")}</dc:creator></cp:coreProperties>`,
      "utf8",
    ),
  });

  return zip(entries);
}
