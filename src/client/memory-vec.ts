// Semantic layer for auto-memory: cosine similarity over a local retrieval-tuned encoder
// (embed-local.ts, MEMORY_MODEL — bge-small by default, a different model from the one codebase
// search uses), blended into recall by RRF alongside the lexical ranker. This is what makes
// "containerize this" find a fact worded "we use Docker" — the lexical ranker's 4-char prefix
// match never could.
//
// Fails OPEN, always: no model, no network, a cold first load, a slow CPU — the query embedding is
// raced against a short budget and recall falls back to lexical alone. A turn is never blocked and
// never fails because of memory.
//
// ponytail: one flat cache file keyed by text hash — not per-scope, not incremental, no compaction.
// Memory is hundreds of facts (a few hundred KB of vectors), so rewriting the whole cache when it
// changes is cheaper than an append cursor and dead-space accounting. Revisit past ~20k facts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MEMORY_MODEL, specFor } from "./embed-local.ts";

const SPEC = specFor(MEMORY_MODEL);

// Read per call, NOT captured at import: memory-vec is imported transitively via memory.ts, so a
// const here would freeze whatever the env said at first import — and any later toggle (the
// selfcheck's offline guarantee, a mid-session opt-out) would silently do nothing.
const enabled = (): boolean => process.env.ADA_MEMORY_SEMANTIC !== "0";
const QUERY_MS = Number(process.env.ADA_MEMORY_EMBED_MS) || 1200; // hot-path budget for the query vector
/**
 * NOISE floor, not a relevance threshold — see bench/memory.ts --calibrate for the measurement.
 *
 * These encoders do not produce a clean absolute cutoff. Over 20 paraphrase probes, MiniLM scored a
 * probe at median 0.24 against its OWN fact and 0.26 against the best unrelated one — the true and
 * false distributions overlap, and the 0.35 this used to be admitted just 3/20 true matches. bge
 * separates better but sits higher (0.53 vs 0.50), which is why the floor is per-model.
 * What these models DO get right is ordering: the target ranks median 1-2 out of 120. So relevance
 * is decided by RANK (RRF over the top-N, see rankHybrid) and this value only screens out the bottom
 * band where off-topic queries live.
 */
export const SIM_FLOOR = Number(process.env.ADA_MEMORY_SIM) || SPEC.noiseFloor;
const MIN_FACTS = 3; // below this the lexical ranker is plenty — don't trigger a 25MB model download
const MAX_CACHED = 4000;

function cacheDir(): string {
  // Mirrors memory.ts memDir("user") — the cache is text→vector, so it is scope-independent and
  // lives in the global dir where it is always writable (a project dir may be read-only/untrusted).
  const base = process.env.ADA_MEMORY_DIR;
  return base ? resolve(base, "user") : resolve(homedir(), ".ada", "memory");
}
const manifestPath = (): string => join(cacheDir(), "vec.json");
const blobPath = (): string => join(cacheDir(), "vec.bin");

const keyOf = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

interface Cache {
  dim: number;
  keys: string[]; // key i occupies floats [i*dim, (i+1)*dim)
  vecs: Float32Array;
}
let cache: Cache | null = null;

function load(): Cache {
  if (cache) return cache;
  try {
    const m = JSON.parse(readFileSync(manifestPath(), "utf8")) as { model: string; dim: number; keys: string[] };
    // A different embedding model makes old vectors incomparable — drop the cache rather than mix.
    if (m.model === MEMORY_MODEL && Array.isArray(m.keys) && m.dim > 0) {
      const buf = readFileSync(blobPath());
      const n = Math.floor(buf.byteLength / 4);
      const ab = new ArrayBuffer(n * 4);
      new Uint8Array(ab).set(buf.subarray(0, n * 4));
      cache = { dim: m.dim, keys: m.keys, vecs: new Float32Array(ab) };
      return cache;
    }
  } catch {
    /* no cache yet, or unreadable — rebuild */
  }
  cache = { dim: 0, keys: [], vecs: new Float32Array(0) };
  return cache;
}

function save(c: Cache): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(blobPath(), Buffer.from(c.vecs.buffer, c.vecs.byteOffset, c.vecs.byteLength));
    writeFileSync(manifestPath(), JSON.stringify({ model: MEMORY_MODEL, dim: c.dim, keys: c.keys }));
  } catch {
    /* best-effort: an unwritable cache costs a re-embed, never a failed turn */
  }
}

/** embedLocal returns unit vectors (normalize: true), so the dot product IS the cosine. */
function dot(a: Float32Array, b: Float32Array, off: number, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[i]! * b[off + i]!;
  return s;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  // .catch on the racer, not the race: a rejection arriving AFTER the timeout would otherwise be
  // an unhandled rejection and take the process down.
  const safe = p.catch(() => null);
  try {
    return await Promise.race([safe, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// Rebuild runs at most once at a time. It embeds every live fact missing from the cache and rewrites
// the cache to EXACTLY the live set — which is also how stale vectors get pruned (no separate GC).
let inflight: Promise<void> | null = null;
/** Embed whatever is missing and rewrite the cache to exactly `texts`. Shared promise, so a caller
 *  that needs the result can await the same work the background path already started.
 *  ponytail: an in-flight fill started with a different fact set is awaited as-is rather than
 *  queued — the next call covers the remainder, and writes are not on the hot path. */
function fill(texts: string[]): Promise<void> {
  if (inflight) return inflight;
  // Resolve the destination NOW. Embedding takes seconds, and by the time it finishes the process
  // may have changed cwd or unset ADA_MEMORY_DIR — resolving inside the callback let a background
  // fill write its cache into the wrong (real) memory directory. Observed, not theoretical.
  const dest = cacheDir();
  inflight = (async () => {
    try {
      const { embedLocal } = await import("./embed-local.ts");
      const c = load();
      const have = new Map<string, number>();
      c.keys.forEach((k, i) => have.set(k, i));
      const live = [...new Set(texts)].slice(0, MAX_CACHED);
      const missing = live.filter((t) => !have.has(keyOf(t)));
      if (!missing.length) return;
      // Facts are the PASSAGE side. The prefix (empty for symmetric models) is applied at embed time
      // only — the cache key stays the raw text, and the manifest records the model, so switching
      // models invalidates everything rather than mixing prefixed and unprefixed vectors.
      const fresh: number[][] = [];
      for (let i = 0; i < missing.length; i += 32) fresh.push(...(await embedLocal(missing.slice(i, i + 32).map((t) => SPEC.doc + t), MEMORY_MODEL)));
      const dim = c.dim || fresh[0]?.length || 0;
      if (!dim) return;
      const freshByKey = new Map(missing.map((t, i) => [keyOf(t), fresh[i]!]));
      const keys = live.map(keyOf);
      const out = new Float32Array(keys.length * dim);
      keys.forEach((k, i) => {
        const v = freshByKey.get(k);
        if (v) out.set(v, i * dim);
        else {
          const old = have.get(k)!;
          out.set(c.vecs.subarray(old * c.dim, old * c.dim + dim), i * dim);
        }
      });
      if (dest !== cacheDir()) return; // target moved out from under us — drop the work, don't misfile it
      cache = { dim, keys, vecs: out };
      save(cache);
    } catch {
      /* model unavailable (offline first run, no disk) — recall stays lexical */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function fillLater(texts: string[]): void {
  void fill(texts).catch(() => {});
}

/**
 * Await the vector cache being current for these facts, time-boxed.
 *
 * Only for WRITE paths (the dedup judge), never for recall. A freshly-stored fact isn't in the cache
 * yet, so the background fill leaves the very next write comparing lexically — which is how a
 * reworded duplicate ("keep responses brief" vs "I always want terse answers") slipped past the
 * judge: it was never shown the fact it duplicated. A write already costs an LLM call, so paying for
 * embeddings here is proportionate; recall still must not.
 * On timeout this resolves anyway and the caller degrades to lexical candidates — never a failed write.
 */
export async function ensureVectors(mems: Array<{ text: string }>, ms = 8000): Promise<void> {
  if (!enabled() || mems.length < MIN_FACTS) return;
  await withTimeout(fill(mems.map((m) => m.text)), ms);
}

/**
 * Cosine of every supplied fact against `query`, keyed by memory id. Only facts already in the
 * cache are scored; anything missing is embedded in the background for the NEXT turn, so the first
 * turn after a new fact is stored is lexical-only rather than slow.
 * Returns an empty map whenever semantic recall is unavailable — the caller must treat that as
 * "no semantic evidence", never as "no match".
 */
export async function semanticScores(query: string, mems: Array<{ id: string; text: string }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!enabled() || mems.length < MIN_FACTS || !query.trim()) return out;
  const c = load();
  if (c.keys.length < mems.length) fillLater(mems.map((m) => m.text)); // background; never awaited
  if (!c.dim || !c.keys.length) return out;

  const { embedLocal } = await import("./embed-local.ts").catch(() => ({ embedLocal: null }) as never);
  if (!embedLocal) return out;
  const q = await withTimeout(embedLocal([SPEC.query + query], MEMORY_MODEL), QUERY_MS); // the QUERY side
  const qv = q?.[0];
  if (!qv || qv.length !== c.dim) return out;
  const qf = Float32Array.from(qv);

  const at = new Map<string, number>();
  c.keys.forEach((k, i) => at.set(k, i));
  for (const m of mems) {
    const i = at.get(keyOf(m.text));
    if (i === undefined) continue;
    out.set(m.id, dot(qf, c.vecs, i * c.dim, c.dim));
  }
  return out;
}

/** Test/CLI seam: forget the in-process cache so a changed ADA_MEMORY_DIR is picked up. */
export function resetVectorCache(): void {
  cache = null;
}
