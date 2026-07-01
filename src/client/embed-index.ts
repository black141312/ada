// @codebase semantic search. Chunks the working tree, embeds chunks through the backend's
// /v1/embeddings (which forwards to Ollama — `ollama pull nomic-embed-text`, or set
// ADA_EMBED_MODEL), caches vectors in .ada/index.json keyed by content hash, and answers queries
// by cosine similarity. Exposed to the model as the read-only `codebase_search` tool.
//
// ponytail: brute-force cosine over a JSON cache — fine to ~50k chunks; an ANN index and a binary
// vector format are the upgrade path if repos outgrow it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EMBED_MODEL = process.env.ADA_EMBED_MODEL ?? "nomic-embed-text";
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
interface IndexedFile {
  hash: string;
  chunks: Array<{ start: number; end: number; vec: number[] }>;
}
interface Index {
  model: string;
  files: Record<string, IndexedFile>;
}

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

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
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
  // nomic-embed models are trained asymmetric: prefixing queries/documents differently measurably
  // improves retrieval (code stops losing to prose). Other models get the raw text.
  const input = EMBED_MODEL.includes("nomic") ? texts.map((t) => `search_${kind}: ${t}`) : texts;
  const res = await fetch(`${BACKEND}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADA_CLIENT_KEY ?? "dev"}` },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)} — is the backend up, and is "${EMBED_MODEL}" pulled in Ollama? (ollama pull nomic-embed-text, or set ADA_EMBED_MODEL)`);
  const j = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  if (!j.data?.length) throw new Error("embeddings response had no data");
  return [...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function indexPath(root: string): string {
  return resolve(root, ".ada", "index.json");
}

// Cache key includes an embedding-scheme tag: changing the model OR how text is prefixed makes old
// vectors incomparable, and both must force a rebuild.
const SCHEME = EMBED_MODEL.includes("nomic") ? `${EMBED_MODEL}#affix1` : EMBED_MODEL;

function loadIndex(root: string): Index {
  try {
    const idx = JSON.parse(readFileSync(indexPath(root), "utf8")) as Index;
    if (idx.model === SCHEME) return idx; // scheme changed → vectors incomparable, rebuild
  } catch {
    /* no cache yet */
  }
  return { model: SCHEME, files: {} };
}

function saveIndex(root: string, idx: Index): void {
  try {
    mkdirSync(resolve(root, ".ada"), { recursive: true });
    writeFileSync(indexPath(root), JSON.stringify(idx));
  } catch {
    /* cache is best-effort */
  }
}

/** Bring the index up to date (embed new/changed files, drop deleted ones). Returns chunk count. */
export async function refreshIndex(root = process.cwd(), onProgress?: (msg: string) => void): Promise<number> {
  const idx = loadIndex(root);
  const files = walkFiles(root);
  const live = new Set(files);
  for (const known of Object.keys(idx.files)) if (!live.has(known)) delete idx.files[known];

  const stale: Array<{ rel: string; hash: string; chunks: Chunk[] }> = [];
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(resolve(root, rel), "utf8");
    } catch {
      continue;
    }
    const hash = sha1(text);
    if (idx.files[rel]?.hash === hash) continue;
    stale.push({ rel, hash, chunks: chunkText(text) });
  }

  let done = 0;
  for (const f of stale) {
    const vecs: number[][] = [];
    for (let i = 0; i < f.chunks.length; i += 32) {
      const batch = f.chunks.slice(i, i + 32);
      vecs.push(...(await embed(batch.map((c) => c.text))));
    }
    idx.files[f.rel] = { hash: f.hash, chunks: f.chunks.map((c, i) => ({ start: c.start, end: c.end, vec: vecs[i]! })) };
    done++;
    if (onProgress && done % 20 === 0) onProgress(`indexed ${done}/${stale.length} changed files…`);
  }
  if (stale.length) saveIndex(root, idx);
  return Object.values(idx.files).reduce((n, f) => n + f.chunks.length, 0);
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
  const idx = loadIndex(root);
  const [qvec] = await embed([query], "query");
  const hits: Hit[] = [];
  for (const [rel, f] of Object.entries(idx.files)) {
    for (const c of f.chunks) {
      hits.push({ file: rel, start: c.start, end: c.end, score: cosine(qvec!, c.vec), snippet: "" });
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
