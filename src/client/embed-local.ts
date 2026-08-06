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
      return (await pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as Extractor;
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
 *  same helper serves both the asymmetric memory path and the unprefixed codebase path. */
export async function embedLocal(texts: string[], model: string = LOCAL_MODEL): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor(model);
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}
