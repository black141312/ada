// Shared plumbing for the zero-dependency OOXML writers (pptx.ts, docx.ts).
// An Office file is an OPC package: a zip of XML parts plus a relationship graph. Everything here is
// format-agnostic — the per-format part builders live in their own modules.

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate, falls back to store) — enough for OPC packages.

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    let method = 8;
    let body: Buffer = deflateRawSync(e.data);
    if (body.length >= e.data.length) {
      method = 0; // deflate made it bigger — store instead
      body = e.data;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1996-01-01 — deterministic output)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---------------------------------------------------------------------------
// XML + relationship helpers.

export const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
export const REL_NS = `xmlns="http://schemas.openxmlformats.org/package/2006/relationships"`;
export const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const EMU = 914400; // English Metric Units per inch

export function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function relsXml(rels: { id: string; type: string; target: string }[]): string {
  return `${XML_DECL}<Relationships ${REL_NS}>${rels.map((r) => `<Relationship Id="${r.id}" Type="${RT}/${r.type}" Target="${esc(r.target)}"/>`).join("")}</Relationships>`;
}

// ---------------------------------------------------------------------------
// Image handling: sniff dimensions so pictures keep their aspect ratio.

export const IMAGE_TYPES: Record<string, string> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif" };

export function imageSize(buf: Buffer, kind: string): { w: number; h: number } | null {
  try {
    if (kind === "png" && buf.readUInt32BE(12) === 0x49484452) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (kind === "gif") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (kind === "jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    /* fall through — caller uses the full bounding box */
  }
  return null;
}
