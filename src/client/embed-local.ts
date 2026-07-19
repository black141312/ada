// Local, in-process embeddings for @codebase semantic search — no API key, no backend, no Ollama.
// Runs a small sentence-transformer (all-MiniLM-L6-v2, 384-dim) via transformers.js on onnxruntime's
// N-API backend, which loads under both Node and Electron. The model (~25MB, quantized) downloads
// once from the HuggingFace CDN and is cached under ~/.ada/models; everything after is offline and
// the code never leaves the machine.
// ponytail: one small general-purpose model, CPU inference — plenty for repo-scale retrieval; swap
// MODEL_ID for a code-tuned model only if search quality measurably needs it.

import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2"; // 384-dim; cache SCHEME keys on this

// transformers.js is ESM-only and heavy — import it lazily so unrelated commands never pay for it,
// and cache the extractor pipeline across calls.
type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractorP: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorP) {
    extractorP = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = process.env.ADA_MODEL_DIR || join(homedir(), ".ada", "models");
      env.allowRemoteModels = true; // fetch once, then served from cache
      return (await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" })) as unknown as Extractor;
    })().catch((e) => {
      extractorP = null; // let a later call retry (e.g. after connectivity returns)
      throw new Error(
        `local embedding model unavailable: ${e instanceof Error ? e.message : String(e)} — first use downloads ~25MB from huggingface.co; check connectivity or set ADA_MODEL_DIR to a prepopulated cache`,
      );
    });
  }
  return extractorP;
}

/** Embed texts locally. Returns one 384-dim unit vector per input, in order. */
export async function embedLocal(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}
