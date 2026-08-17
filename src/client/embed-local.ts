// Local, in-process embeddings for @codebase semantic search — no API key, no backend, no Ollama.
// Runs a small sentence-transformer (all-MiniLM-L6-v2, 384-dim) via transformers.js on onnxruntime's
// N-API backend, which loads under both Node and Electron. The model (~25MB, quantized) downloads
// once from the HuggingFace CDN and is cached under ~/.ada/models; everything after is offline and
// the code never leaves the machine.
// ponytail: one small general-purpose model, CPU inference — plenty for repo-scale retrieval; swap
// MODEL_ID for a code-tuned model only if search quality measurably needs it.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-model retrieval config. Retrieval-tuned encoders are ASYMMETRIC — they were trained with the
 * query side and the passage side marked differently, and omitting the marker measurably costs
 * recall. `noiseFloor` is the cosine below which a match is indistinguishable from an unrelated one,
 * and it is model-specific: MiniLM's true matches sit around 0.24, bge's around 0.53, so a single
 * shared constant would be wrong for one of them. Measure a new model with
 * `npx tsx bench/memory.ts --compare-models` before adding it here.
 */
export interface ModelSpec {
  query: string;
  doc: string;
  noiseFloor: number;
}
const SPECS: Record<string, ModelSpec> = {
  "Xenova/all-MiniLM-L6-v2": { query: "", doc: "", noiseFloor: 0.22 },
  "Xenova/bge-small-en-v1.5": { query: "Represent this sentence for searching relevant passages: ", doc: "", noiseFloor: 0.5 },
  // Measured WORSE than bge-small end-to-end (60% vs 75% hit) despite being 3x the download. Kept
  // so the negative result is recorded and re-testable rather than re-litigated.
  "Xenova/bge-base-en-v1.5": { query: "Represent this sentence for searching relevant passages: ", doc: "", noiseFloor: 0.56 },
  "Xenova/gte-small": { query: "", doc: "", noiseFloor: 0.78 },
  "Xenova/e5-small-v2": { query: "query: ", doc: "passage: ", noiseFloor: 0.79 },
};

// 384-dim; the codebase index's cache SCHEME keys on this, so changing it forces a full repo
// re-embed rather than mixing vector spaces.
export const LOCAL_MODEL = process.env.ADA_EMBED_LOCAL_MODEL || "Xenova/all-MiniLM-L6-v2";

/**
 * Memory recall uses a DIFFERENT encoder from codebase search, deliberately.
 * Measured on bench/memory.ts: swapping MiniLM for bge-small took memory hit rate 55% → 65%, MRR
 * 0.36 → 0.46, and off-topic false positives 1/8 → 0/8. That evidence is about short-question →
 * short-fact retrieval and says nothing about chunk-of-code retrieval, so codebase search keeps
 * MiniLM until someone measures it. Both are 384-dim and ~25-33MB; only the one you use downloads.
 */
export const MEMORY_MODEL = process.env.ADA_MEMORY_EMBED_MODEL || "Xenova/bge-small-en-v1.5";

const FALLBACK_SPEC: ModelSpec = { query: "", doc: "", noiseFloor: 0.22 };
export const specFor = (model: string): ModelSpec => SPECS[model] ?? FALLBACK_SPEC;

/**
 * How many texts go through the encoder at once. Peak memory is dominated by attention, which scales
 * with batch x seq^2 — and an 80-line code chunk fills all 512 positions, so a batch is always at the
 * model's worst case. Measured on this model (96 chunks, same total work):
 *
 *   batch 32 -> 2085 MB peak, 3002 ms      batch 8 -> ~680 MB peak, ~2400 ms
 *
 * Smaller is both leaner AND faster here: 32 spills out of cache without buying any parallelism that
 * CPU inference can use. This is not a tuning nicety — callers used to hand the encoder 32 at once,
 * and on a loaded machine the ~1.4 GB spike aborted the process. onnxruntime runs under Electron's
 * allocator when the CLI is spawned by the desktop app (ELECTRON_RUN_AS_NODE), and that allocator
 * turns a failed native allocation into an immediate fatal trap rather than a catchable error, so
 * the whole `ada serve` backend died and the UI reported it as a dropped connection.
 * Lower it further on a memory-tight machine; raising it past ~16 gives back nothing.
 */
const BATCH = Math.max(1, Number(process.env.ADA_EMBED_BATCH) || 8);

/**
 * onnxruntime's BFC arena keeps every block it has ever grown to — after one index pass the process
 * stays at ~96% of its peak forever, which matters because `ada serve` is long-lived. Turning the
 * arena off returns memory between batches (625 MB -> 500 MB resident, measured) at ~25% slower
 * embedding, so it is opt-in rather than the default.
 */
const LOW_MEMORY = process.env.ADA_EMBED_LOW_MEMORY === "1";

// transformers.js is ESM-only and heavy — import it lazily so unrelated commands never pay for it,
// and cache each extractor pipeline across calls (keyed by model: memory and codebase search can
// legitimately want different ones, and a single slot would thrash between them).
type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
const extractors = new Map<string, Promise<Extractor>>();

async function getExtractor(model: string): Promise<Extractor> {
  let p = extractors.get(model);
  if (!p) {
    p = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = process.env.ADA_MODEL_DIR || join(homedir(), ".ada", "models");
      env.allowRemoteModels = true; // fetch once, then served from cache
      const session_options = LOW_MEMORY ? { enableCpuMemArena: false } : {};
      return (await pipeline("feature-extraction", model, { dtype: "q8", session_options })) as unknown as Extractor;
    })().catch((e) => {
      extractors.delete(model); // let a later call retry (e.g. after connectivity returns)
      throw new Error(
        `local embedding model unavailable (${model}): ${e instanceof Error ? e.message : String(e)} — first use downloads ~25-33MB from huggingface.co; check connectivity or set ADA_MODEL_DIR to a prepopulated cache`,
      );
    });
    extractors.set(model, p);
  }
  return p;
}

/** Embed texts locally. Returns one 384-dim unit vector per input, in order.
 *  Callers must apply the model's query/doc prefix themselves (see specFor) — this stays dumb so the
 *  same helper serves both the asymmetric memory path and the unprefixed codebase path.
 *  Sub-batching lives HERE rather than at the call sites: the callers batch for their own reasons
 *  (an HTTP request wants a big payload, this encoder wants a small one), and only this side knows
 *  what the encoder can afford. A caller can still pass thousands of texts in one call. */
export async function embedLocal(texts: string[], model: string = LOCAL_MODEL): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor(model);
  // Padding is per-batch, so ONE long text inflates every short one sitting beside it to its length.
  // Grouping similar lengths together cuts the padding that gets computed and thrown away: measured
  // 673MB -> 598MB peak over this repo's src/, same wall time. Length in characters is a good enough
  // proxy for token count to bucket by, and much cheaper than tokenizing twice.
  // Order is restored before returning — callers index the result positionally against their input.
  const order = texts.map((_, i) => i).sort((a, b) => texts[a]!.length - texts[b]!.length);
  const out: number[][] = new Array(texts.length);
  for (let i = 0; i < order.length; i += BATCH) {
    const idx = order.slice(i, i + BATCH);
    const part = await extractor(
      idx.map((j) => texts[j]!),
      { pooling: "mean", normalize: true },
    );
    part.tolist().forEach((v, k) => (out[idx[k]!] = v));
  }
  return out;
}
