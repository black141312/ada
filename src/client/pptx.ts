// Zero-dependency .pptx writer — a deterministic renderer so any model (even a weak local one)
// can produce a real, editable PowerPoint deck by emitting structured JSON instead of code.
// A .pptx is an OPC zip of OOXML parts; we generate the minimal valid set: content types,
// package rels, presentation + master + blank layout + theme, one slide part per slide
// (explicit text boxes, no placeholder inheritance), optional embedded images and speaker notes.

import { readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { EMU, IMAGE_TYPES, REL_NS, RT, XML_DECL, esc, imageSize, relsXml, zip } from "./ooxml.ts";

export interface PptxBullet {
  text: string;
  level?: number; // 0-based indent level
}

export interface PptxChartDatum {
  label: string;
  value: number;
}

export interface PptxMetric {
  value: string; // the headline figure, e.g. "340+" or "99.9%"
  label?: string; // what it measures
}

export interface PptxSlideSpec {
  title?: string;
  subtitle?: string; // present (with no bullets) ⇒ centered title-slide treatment
  bullets?: (string | PptxBullet)[];
  image?: string; // path to a local png/jpg/gif, embedded into the file
  chart?: { data: PptxChartDatum[]; unit?: string }; // horizontal bar chart, drawn as native shapes
  metrics?: PptxMetric[]; // a row of big KPI figures
  notes?: string; // speaker notes
}

export interface PptxSpec {
  title?: string; // deck title for document properties
  author?: string;
  slides: PptxSlideSpec[];
}



// ---------------------------------------------------------------------------
// OOXML part builders. All geometry in EMU (914400/inch); slide is 16:9.

const SLIDE_W = 12192000; // 13.333in
const SLIDE_H = 6858000; // 7.5in
const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;

const COLOR = { title: "202124", body: "3C4043", accent: "4472C4", muted: "5F6368" };

const inch = (n: number): number => Math.round(n * EMU);

function emptyTree(shapes = ""): string {
  return (
    `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`
  );
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function textShape(
  id: number,
  name: string,
  box: Box,
  paragraphs: string,
  opts: { anchor?: "t" | "ctr"; align?: "l" | "ctr" } = {},
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" anchor="${opts.anchor ?? "t"}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function para(text: string, opts: { sz: number; bold?: boolean; color: string; align?: "l" | "ctr"; bullet?: boolean; level?: number }): string {
  const lvl = Math.min(Math.max(opts.level ?? 0, 0), 4);
  const marL = 285750 + lvl * 457200;
  const pPr =
    `<a:pPr${opts.bullet ? ` marL="${marL}" indent="-285750" lvl="${lvl}"` : ""}${opts.align === "ctr" ? ` algn="ctr"` : ""}>` +
    `<a:spcBef><a:spcPts val="${opts.bullet ? 600 : 0}"/></a:spcBef>` +
    (opts.bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${lvl % 2 ? "–" : "•"}"/>` : `<a:buNone/>`) +
    `</a:pPr>`;
  const rPr = `<a:rPr lang="en-US" sz="${opts.sz}"${opts.bold ? ` b="1"` : ""} dirty="0"><a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill></a:rPr>`;
  return `<a:p>${pPr}<a:r>${rPr}<a:t>${esc(text)}</a:t></a:r></a:p>`;
}

function accentBar(id: number, box: Box): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${COLOR.accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`
  );
}

/** A filled rectangle (rounded when `round`) — the building block for charts and KPI tiles. */
function rectShape(id: number, box: Box, fill: string, round = false): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(box.x)}" y="${Math.round(box.y)}"/><a:ext cx="${Math.max(1, Math.round(box.w))}" cy="${Math.max(1, Math.round(box.h))}"/></a:xfrm>` +
    `<a:prstGeom prst="${round ? "roundRect" : "rect"}"><a:avLst${round ? `><a:gd name="adj" fmla="val 12000"/></a:avLst` : "/"}></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`
  );
}

/** Horizontal bar chart as native shapes: label, bar, value. Editable in PowerPoint, no image needed. */
function chartShapes(startId: number, box: Box, data: PptxChartDatum[], unit = ""): { xml: string; nextId: number } {
  const rows = data.slice(0, 10).filter((d) => d && typeof d.label === "string");
  if (!rows.length) return { xml: "", nextId: startId };
  const max = Math.max(...rows.map((d) => Math.abs(Number(d.value) || 0)), 1);
  const rowH = Math.min(inch(0.62), box.h / rows.length);
  const barH = Math.round(rowH * 0.52);
  const labelW = Math.round(box.w * 0.28);
  const valueW = inch(1.1);
  const trackW = box.w - labelW - valueW - inch(0.2);
  let id = startId;
  const out: string[] = [];
  rows.forEach((d, i) => {
    const v = Number(d.value) || 0;
    const y = box.y + i * rowH;
    const barW = Math.max(inch(0.04), (Math.abs(v) / max) * trackW);
    // label
    out.push(
      textShape(id++, "ChartLabel", { x: box.x, y: y + Math.round((rowH - barH) / 2) - inch(0.06), w: labelW, h: rowH }, para(d.label, { sz: 1200, color: COLOR.body })),
    );
    // track + bar
    out.push(rectShape(id++, { x: box.x + labelW, y: y + (rowH - barH) / 2, w: trackW, h: barH }, "EDF0F6", true));
    out.push(rectShape(id++, { x: box.x + labelW, y: y + (rowH - barH) / 2, w: barW, h: barH }, COLOR.accent, true));
    // value
    out.push(
      textShape(id++, "ChartValue", { x: box.x + labelW + trackW + inch(0.15), y: y + Math.round((rowH - barH) / 2) - inch(0.06), w: valueW, h: rowH }, para(`${v}${unit}`, { sz: 1200, bold: true, color: COLOR.title })),
    );
  });
  return { xml: out.join(""), nextId: id };
}

/** A row of KPI tiles: big figure over a caption. */
function metricShapes(startId: number, box: Box, metrics: PptxMetric[]): { xml: string; nextId: number } {
  const items = metrics.slice(0, 4).filter((m) => m && (m.value != null || m.label));
  if (!items.length) return { xml: "", nextId: startId };
  const gap = inch(0.25);
  const w = (box.w - gap * (items.length - 1)) / items.length;
  const h = Math.min(box.h, inch(1.9));
  let id = startId;
  const out: string[] = [];
  items.forEach((m, i) => {
    const x = box.x + i * (w + gap);
    out.push(rectShape(id++, { x, y: box.y, w, h }, "F4F6FA", true));
    out.push(textShape(id++, "MetricValue", { x, y: box.y + inch(0.28), w, h: inch(0.9) }, para(String(m.value ?? ""), { sz: 3600, bold: true, color: COLOR.accent, align: "ctr" })));
    if (m.label) out.push(textShape(id++, "MetricLabel", { x, y: box.y + inch(1.15), w, h: inch(0.5) }, para(m.label, { sz: 1200, color: COLOR.muted, align: "ctr" })));
  });
  return { xml: out.join(""), nextId: id };
}

function picShape(id: number, relId: string, box: Box, natural: { w: number; h: number } | null): string {
  let { x, y, w, h } = box;
  if (natural && natural.w > 0 && natural.h > 0) {
    const scale = Math.min(w / natural.w, h / natural.h);
    const fw = Math.round(natural.w * scale);
    const fh = Math.round(natural.h * scale);
    x += Math.round((w - fw) / 2);
    y += Math.round((h - fh) / 2);
    w = fw;
    h = fh;
  }
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function themeXml(name: string): string {
  const fills =
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="90000"/></a:schemeClr></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="80000"/></a:schemeClr></a:solidFill>`;
  const lines = [12700, 19050, 25400]
    .map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`)
    .join("");
  return (
    `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>` +
    `<a:clrScheme name="ada"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
    `<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
    `<a:fontScheme name="ada"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="ada"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
  );
}

// ---------------------------------------------------------------------------

/** Render a deck spec to .pptx bytes. Image paths resolve against `cwd`. Throws on bad input. */
export function buildPptx(spec: PptxSpec, cwd = process.cwd()): Buffer {
  const raw = spec.slides ?? [];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("generate_pptx: `slides` must be a non-empty array of slide objects");
  const slides: PptxSlideSpec[] = raw.map((s) => (typeof s === "string" ? { title: s } : (s ?? {})));
  if (slides.length > 200) throw new Error("generate_pptx: too many slides (max 200)");

  const entries: { name: string; data: Buffer }[] = [];
  const put = (name: string, xml: string): void => {
    entries.push({ name, data: Buffer.from(xml, "utf8") });
  };

  const usedImageExts = new Set<string>();
  const overrides: string[] = [];
  const anyNotes = slides.some((s) => s.notes?.trim());
  let media = 0;

  // Per-slide parts.
  slides.forEach((s, i) => {
    const n = i + 1;
    const shapes: string[] = [];
    const rels: { id: string; type: string; target: string }[] = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];
    let shapeId = 2;
    let nextRel = 2;

    // Tolerate weak-model shapes: a lone string (split on newlines) or a JSON-stringified array.
    let rawBullets: unknown = s.bullets ?? [];
    if (typeof rawBullets === "string") {
      const str: string = rawBullets;
      try {
        rawBullets = str.trim().startsWith("[") ? JSON.parse(str) : str.split(/\r?\n/).filter(Boolean);
      } catch {
        rawBullets = str.split(/\r?\n/).filter(Boolean);
      }
    }
    if (!Array.isArray(rawBullets)) throw new Error(`generate_pptx: slide ${n}: \`bullets\` must be an array of strings or {text, level} objects`);
    const bullets = rawBullets.map((b) => (typeof b === "string" ? { text: b, level: 0 } : { text: String((b as PptxBullet)?.text ?? ""), level: Number((b as PptxBullet)?.level) || 0 }));
    const isTitleSlide = !bullets.length && !s.image && (i === 0 || s.subtitle != null);

    let imageRel: string | null = null;
    let natural: { w: number; h: number } | null = null;
    if (s.image) {
      const abs = isAbsolute(s.image) ? s.image : resolve(cwd, s.image);
      const kind = IMAGE_TYPES[extname(abs).toLowerCase()];
      if (!kind) throw new Error(`generate_pptx: slide ${n}: unsupported image type "${extname(abs)}" (png/jpg/gif)`);
      const data = readFileSync(abs); // throws a clear ENOENT if missing
      media++;
      const ext = kind === "jpeg" ? "jpeg" : kind;
      usedImageExts.add(ext);
      entries.push({ name: `ppt/media/image${media}.${ext}`, data });
      imageRel = `rId${nextRel++}`;
      rels.push({ id: imageRel, type: "image", target: `../media/image${media}.${ext}` });
      natural = imageSize(data, kind);
    }

    if (isTitleSlide) {
      if (s.title) shapes.push(textShape(shapeId++, "Title", { x: inch(1), y: inch(2.5), w: SLIDE_W - inch(2), h: inch(1.5) }, para(s.title, { sz: 4400, bold: true, color: COLOR.title, align: "ctr" }), { anchor: "ctr" }));
      shapes.push(accentBar(shapeId++, { x: (SLIDE_W - inch(1.5)) / 2, y: inch(4.1), w: inch(1.5), h: inch(0.06) }));
      if (s.subtitle) shapes.push(textShape(shapeId++, "Subtitle", { x: inch(1), y: inch(4.35), w: SLIDE_W - inch(2), h: inch(1) }, para(s.subtitle, { sz: 2000, color: COLOR.muted, align: "ctr" })));
    } else {
      if (s.title) {
        shapes.push(textShape(shapeId++, "Title", { x: inch(0.6), y: inch(0.35), w: SLIDE_W - inch(1.2), h: inch(0.9) }, para(s.title, { sz: 2800, bold: true, color: COLOR.title })));
        shapes.push(accentBar(shapeId++, { x: inch(0.6), y: inch(1.25), w: inch(1.2), h: inch(0.05) }));
      }
      if (s.subtitle) shapes.push(textShape(shapeId++, "Subtitle", { x: inch(0.6), y: inch(1.45), w: SLIDE_W - inch(1.2), h: inch(0.6) }, para(s.subtitle, { sz: 1600, color: COLOR.muted })));
      const bodyY = s.subtitle ? inch(2.1) : inch(1.6);
      const bodyH = SLIDE_H - bodyY - inch(0.5);
      // KPI row sits above the body; bullets/visual share the remaining height.
      let contentY = bodyY;
      let contentH = bodyH;
      const metrics = Array.isArray(s.metrics) ? s.metrics : null;
      if (metrics?.length) {
        const m = metricShapes(shapeId, { x: inch(0.6), y: contentY, w: SLIDE_W - inch(1.2), h: inch(1.9) }, metrics);
        shapes.push(m.xml);
        shapeId = m.nextId;
        contentY += inch(2.15);
        contentH -= inch(2.15);
      }
      const chartData = Array.isArray(s.chart?.data) ? s.chart!.data : null;
      // A visual (chart or image) sits beside bullets when both are present, else fills the width.
      const visual = chartData?.length ? "chart" : imageRel ? "image" : null;
      if (bullets.length) {
        const bodyW = visual ? inch(6.4) : SLIDE_W - inch(1.2);
        const sz = bullets.length > 8 ? 1400 : 1800;
        shapes.push(textShape(shapeId++, "Body", { x: inch(0.6), y: contentY, w: bodyW, h: contentH }, bullets.map((b) => para(b.text, { sz, color: COLOR.body, bullet: true, level: b.level })).join("")));
        if (visual === "chart") {
          const c = chartShapes(shapeId, { x: inch(7.1), y: contentY + inch(0.1), w: SLIDE_W - inch(7.7), h: contentH - inch(0.2) }, chartData!, s.chart?.unit ?? "");
          shapes.push(c.xml);
          shapeId = c.nextId;
        } else if (visual === "image") {
          shapes.push(picShape(shapeId++, imageRel!, { x: inch(7.3), y: contentY, w: SLIDE_W - inch(7.9), h: contentH }, natural));
        }
      } else if (visual === "chart") {
        const c = chartShapes(shapeId, { x: inch(1.2), y: contentY + inch(0.2), w: SLIDE_W - inch(2.4), h: contentH - inch(0.4) }, chartData!, s.chart?.unit ?? "");
        shapes.push(c.xml);
        shapeId = c.nextId;
      } else if (visual === "image") {
        shapes.push(picShape(shapeId++, imageRel!, { x: inch(1), y: contentY, w: SLIDE_W - inch(2), h: contentH }, natural));
      }
    }

    if (s.notes?.trim()) {
      const notesRel = `rId${nextRel++}`;
      rels.push({ id: notesRel, type: "notesSlide", target: `../notesSlides/notesSlide${n}.xml` });
      const notesBody =
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${s.notes.split("\n").map((line) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
      put(`ppt/notesSlides/notesSlide${n}.xml`, `${XML_DECL}<p:notes ${NS}><p:cSld>${emptyTree(notesBody)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
      put(
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        relsXml([
          { id: "rId1", type: "notesMaster", target: "../notesMasters/notesMaster1.xml" },
          { id: "rId2", type: "slide", target: `../slides/slide${n}.xml` },
        ]),
      );
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
    }

    put(`ppt/slides/slide${n}.xml`, `${XML_DECL}<p:sld ${NS}><p:cSld>${emptyTree(shapes.join(""))}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    put(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels));
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  });

  // Presentation, master, layout, themes.
  const presRels: { id: string; type: string; target: string }[] = [{ id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" }];
  slides.forEach((_, i) => presRels.push({ id: `rId${i + 2}`, type: "slide", target: `slides/slide${i + 1}.xml` }));
  if (anyNotes) presRels.push({ id: `rId${slides.length + 2}`, type: "notesMaster", target: "notesMasters/notesMaster1.xml" });
  put(
    "ppt/presentation.xml",
    `${XML_DECL}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      (anyNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 2}"/></p:notesMasterIdLst>` : "") +
      `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  put("ppt/_rels/presentation.xml.rels", relsXml(presRels));
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `${XML_DECL}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${emptyTree()}</p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  put(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    relsXml([
      { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
    ]),
  );
  put("ppt/slideLayouts/slideLayout1.xml", `${XML_DECL}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${emptyTree()}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relsXml([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]));
  put("ppt/theme/theme1.xml", themeXml("ada"));
  if (anyNotes) {
    put(
      "ppt/notesMasters/notesMaster1.xml",
      `${XML_DECL}<p:notesMaster ${NS}><p:cSld>${emptyTree()}</p:cSld>` +
        `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`,
    );
    put("ppt/notesMasters/_rels/notesMaster1.xml.rels", relsXml([{ id: "rId1", type: "theme", target: "../theme/theme2.xml" }]));
    put("ppt/theme/theme2.xml", themeXml("ada-notes"));
    overrides.push(`<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`);
    overrides.push(`<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`);
  }

  // Document properties.
  put(
    "docProps/core.xml",
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:title>${esc(spec.title ?? "")}</dc:title><dc:creator>${esc(spec.author ?? "ada")}</dc:creator></cp:coreProperties>`,
  );
  put(
    "docProps/app.xml",
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ada</Application><Slides>${slides.length}</Slides></Properties>`,
  );

  // Package-level parts.
  const defaults =
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    [...usedImageExts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("");
  put(
    "[Content_Types].xml",
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      `${overrides.join("")}` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  put(
    "_rels/.rels",
    relsXml([
      { id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" },
      { id: "rId3", type: "extended-properties", target: "docProps/app.xml" },
    ]).replace(
      "</Relationships>",
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
  );

  return zip(entries);
}
