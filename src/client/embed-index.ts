// @codebase semantic search. Chunks the working tree, embeds chunks (locally by default), and answers
// queries by cosine similarity. Exposed to the model as the read-only `codebase_search` tool.
//
// Storage is SSD-friendly: vectors live in a binary append-only blob (.ada/index.vec, packed Float32),
// and a tiny JSON manifest (.ada/index.json) maps files → chunk metadata + blob offsets. Editing one
// file appends only its vectors and rewrites the small manifest — NOT the whole index. The blob is
// only fully rewritten during occasional compaction, once dead space (from replaced/deleted files)
// exceeds a threshold. This keeps write volume proportional to what changed, not the index size.
//
// ponytail: brute-force cosine over the in-memory blob — fine to ~50k chunks; an ANN index is the
// next upgrade if repos outgrow it.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { projectRootOf } from "./brain.ts";
import { LOCAL_MODEL, embedLocal } from "./embed-local.ts";

// Embeddings run LOCALLY by default (in-process, no key/backend — see embed-local.ts). Set
// ADA_EMBED_REMOTE=1 to instead POST to the backend's /v1/embeddings (Ollama/Gemini/OpenAI).
const REMOTE = process.env.ADA_EMBED_REMOTE === "1";
const EMBED_MODEL = REMOTE ? (process.env.ADA_EMBED_MODEL ?? "text-embedding-004") : LOCAL_MODEL;
const BACKEND = process.env.ADA_BACKEND_URL ?? "http://localhost:8787/v1";
const SKIP = new Set(["node_modules", ".git", "dist", ".ada", ".next", "build", "coverage"]);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|md|txt|json|yaml|yml|toml|css|scss|html|sql|sh|svelte|vue)$/i;
const CHUNK_LINES = 80;
const MAX_FILE_BYTES = 200_000;

export interface Chunk {
  start: number; // 1-based first line
  end: number;
  text: string;
}
// A file's chunk vectors sit contiguously in the blob starting at float offset `base`; chunk i's
// vector occupies floats [base + i*dim, base + (i+1)*dim). Only line ranges live in the manifest.
interface FileEntry {
  hash: string;
  base: number;
  chunks: Array<{ start: number; end: number }>;
}
interface Manifest {
  v: number; // format version — a bump forces a rebuild
  model: string;
  dim: number; // vector dimension (0 until the first file is embedded)
  used: number; // floats written to the blob (the append cursor)
  dead: number; // floats orphaned by replaced/deleted files, awaiting compaction
  files: Record<string, FileEntry>;
}
const FORMAT = 2;

/** Split file text into fixed-size line windows, char-capped so minified/long-line files can't
 *  blow the embedding model's context window. */
export function chunkText(text: string, lines = CHUNK_LINES): Chunk[] {
  const all = text.split("\n");
  const out: Chunk[] = [];
  for (let i = 0; i < all.length; i += lines) {
    const slice = all.slice(i, i + lines).join("\n");
    if (slice.trim()) out.push({ start: i + 1, end: Math.min(i + lines, all.length), text: slice.slice(0, 6000) });
  }
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Indexable text files under root (relative paths), matching the tool suite's skip list. */
export function walkFiles(root: string, dir = root, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(root, p, out);
    else if (TEXT_EXT.test(e.name)) {
      try {
        if (statSync(p).size <= MAX_FILE_BYTES) out.push(relative(root, p).replace(/\\/g, "/"));
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return out;
}

async function embed(texts: string[], kind: "document" | "query" = "document"): Promise<number[][]> {
  if (!REMOTE) return embedLocal(texts); // default: in-process, no key/backend
  // nomic-embed models are trained asymmetric: prefixing queries/documents differently measurably
  // improves retrieval (code stops losing to prose). Other models get the raw text.
  const input = EMBED_MODEL.includes("nomic") ? texts.map((t) => `search_${kind}: ${t}`) : texts;
  const res = await fetch(`${BACKEND}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADA_CLIENT_KEY ?? "dev"}` },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)} — is the backend up and an embedding provider configured?`);
  const j = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  if (!j.data?.length) throw new Error("embeddings response had no data");
  return [...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Worktree sessions share the main project's .ada, so the index is built once and visible there.
function adaDir(root: string): string {
  return resolve(projectRootOf(root), ".ada");
}
function manifestPath(root: string): string {
  return join(adaDir(root), "index.json");
}
function blobPath(root: string): string {
  return join(adaDir(root), "index.vec");
}

// Cache key includes an embedding-scheme tag: changing the model OR how text is prefixed makes old
// vectors incomparable, and both must force a rebuild.
const SCHEME = EMBED_MODEL.includes("nomic") ? `${EMBED_MODEL}#affix1` : EMBED_MODEL;
const COMPACT_AT = 0.4; // rewrite the blob once dead space exceeds this fraction of it

function emptyManifest(): Manifest {
  return { v: FORMAT, model: SCHEME, dim: 0, used: 0, dead: 0, files: {} };
}
function loadManifest(root: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(manifestPath(root), "utf8")) as Manifest;
    if (m.v === FORMAT && m.model === SCHEME) return m; // else format/scheme changed → rebuild
  } catch {
    /* none yet or unreadable */
  }
  return emptyManifest();
}
function saveManifest(root: string, m: Manifest): void {
  try {
    mkdirSync(adaDir(root), { recursive: true });
    writeFileSync(manifestPath(root), JSON.stringify(m));
  } catch {
    /* best-effort */
  }
}
/** Read the whole vector blob into an aligned Float32Array (copied, so it's safe to view/slice). */
function readBlob(root: string): Float32Array {
  try {
    const buf = readFileSync(blobPath(root));
    const n = Math.floor(buf.byteLength / 4);
    const ab = new ArrayBuffer(n * 4);
    new Uint8Array(ab).set(buf.subarray(0, n * 4));
    return new Float32Array(ab);
  } catch {
    return new Float32Array(0);
  }
}
function appendVectors(root: string, floats: Float32Array): void {
  appendFileSync(blobPath(root), Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength));
}
/** Rewrite the blob keeping only live vectors (the ONLY full rewrite; happens rarely). */
function compact(root: string, m: Manifest): void {
  const blob = readBlob(root);
  const liveFloats = Object.values(m.files).reduce((n, f) => n + f.chunks.length * m.dim, 0);
  const out = new Float32Array(liveFloats);
  let cur = 0;
  for (const f of Object.values(m.files)) {
    const n = f.chunks.length * m.dim;
    out.set(blob.subarray(f.base, f.base + n), cur);
    f.base = cur;
    cur += n;
  }
  mkdirSync(adaDir(root), { recursive: true });
  writeFileSync(blobPath(root), Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  m.used = cur;
  m.dead = 0;
}

/** Bring the index up to date (embed new/changed files, drop deleted ones). Returns chunk count.
 *  Writes are incremental: only changed files' vectors are appended; the blob is fully rewritten
 *  only when dead space passes COMPACT_AT. */
export async function refreshIndex(root = process.cwd(), onProgress?: (msg: string) => void): Promise<number> {
  const m = loadManifest(root);
  // Fresh manifest (first run, or format/scheme change) → start the blob clean so old bytes can't leak.
  if (m.used === 0) {
    try {
      mkdirSync(adaDir(root), { recursive: true });
      writeFileSync(blobPath(root), Buffer.alloc(0));
    } catch {
      /* best-effort */
    }
  }

  const files = walkFiles(root);
  const live = new Set(files);
  for (const rel of Object.keys(m.files)) {
    if (!live.has(rel)) {
      m.dead += m.files[rel]!.chunks.length * m.dim; // deleted → its vectors are now dead
      delete m.files[rel];
    }
  }

  const stale: Array<{ rel: string; hash: string; chunks: Chunk[] }> = [];
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(resolve(root, rel), "utf8");
    } catch {
      continue;
    }
    const hash = sha1(text);
    if (m.files[rel]?.hash === hash) continue;
    stale.push({ rel, hash, chunks: chunkText(text) });
  }

  let done = 0;
  for (const f of stale) {
    const vecs: number[][] = [];
    for (let i = 0; i < f.chunks.length; i += 32) {
      vecs.push(...(await embed(f.chunks.slice(i, i + 32).map((c) => c.text))));
    }
    if (!m.dim && vecs[0]) m.dim = vecs[0].length;
    const old = m.files[f.rel];
    if (old) m.dead += old.chunks.length * m.dim; // replaced → old vectors are now dead
    // Pack this file's vectors and append them to the blob at the current cursor.
    const flat = new Float32Array(vecs.length * m.dim);
    for (let i = 0; i < vecs.length; i++) flat.set(vecs[i]!, i * m.dim);
    appendVectors(root, flat);
    m.files[f.rel] = { hash: f.hash, base: m.used, chunks: f.chunks.map((c) => ({ start: c.start, end: c.end })) };
    m.used += flat.length;
    done++;
    if (onProgress && done % 20 === 0) onProgress(`indexed ${done}/${stale.length} changed files…`);
  }

  if (stale.length || m.dead) {
    if (m.used > 0 && m.dead / m.used > COMPACT_AT) compact(root, m);
    saveManifest(root, m);
  }
  return Object.values(m.files).reduce((n, f) => n + f.chunks.length, 0);
}

export interface Hit {
  file: string;
  start: number;
  end: number;
  score: number;
  snippet: string;
}

/** Top-k chunks most similar to the query. Refreshes the index first (incremental). */
export async function searchCodebase(query: string, k = 6, root = process.cwd()): Promise<Hit[]> {
  await refreshIndex(root);
  const m = loadManifest(root);
  const blob = readBlob(root);
  const dim = m.dim;
  const [qvec] = await embed([query], "query");
  const hits: Hit[] = [];
  for (const [rel, f] of Object.entries(m.files)) {
    for (let i = 0; i < f.chunks.length; i++) {
      const off = f.base + i * dim;
      const c = f.chunks[i]!;
      hits.push({ file: rel, start: c.start, end: c.end, score: cosine(qvec!, blob.subarray(off, off + dim)), snippet: "" });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k);
  for (const h of top) {
    try {
      h.snippet = readFileSync(resolve(root, h.file), "utf8")
        .split("\n")
        .slice(h.start - 1, h.end)
        .join("\n")
        .slice(0, 1200);
    } catch {
      h.snippet = "(file changed since indexing)";
    }
  }
  return top;
}
