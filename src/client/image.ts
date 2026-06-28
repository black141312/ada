// Load an image file into a data URL for multimodal messages (OpenAI image_url format).

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function loadImage(path: string): { dataUrl: string; bytes: number; name: string } | null {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) return null;
  const mime = MIME[extname(abs).toLowerCase()];
  if (!mime) return null;
  try {
    const buf = readFileSync(abs);
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length, name: path };
  } catch {
    return null;
  }
}
