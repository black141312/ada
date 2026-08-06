// Cross-encoder reranking for auto-memory recall — the last stage of retrieve → fuse → rerank.
//
// The bi-encoder (memory-vec.ts) embeds the query and each fact SEPARATELY, so it never gets to look
// at the two together; it can only compare two summaries after the fact. That is why its cosines came
// out flat (bench/memory.ts --calibrate: a probe scored 0.53 against its own fact and 0.50 against an
// unrelated one) and why recall plateaued at 75%. A cross-encoder reads (query, fact) as ONE input
// with full attention across the pair, which is strictly more informative — and strictly more
// expensive, because it is a forward pass PER CANDIDATE rather than one shared embedding.
//
// So it runs last and on a short list: rerank only what fusion already shortlisted, never the ledger.
//
// DEFAULT OFF — it did not earn its place. Measured on bench/memory.ts (ledger 120, bge-small +
// bge-reranker-base):
//
//   sim_floor  rerank    hit    MRR   injected  off-topic-noise
//   0.50       off       75%   0.53       4.3   0/8   <- shipped default
//   0.50       on        70%   0.45       4.3   0/8
//   0.42       on        85%   0.40       6.9   5/8
//   0.35       on        85%   0.42       7.0   8/8
//
// Two things killed it. First, reranking only REORDERS what retrieval already found, and fusion
// already places the target at rank ~1.4 when it finds it — so there was almost no ordering left to
// win, while the 25% it misses are missed at the retrieval stage, which the reranker never sees.
// Second, the classic fix for that (retrieve loosely, let the reranker restore precision) does raise
// hit rate, but only by saturating the K=7 budget on every turn and injecting facts on 5-8 of 8
// off-topic queries — trading the cost-free-until-relevant guarantee for facts the model must then
// ignore. bge-reranker-base is also only 6/10 top-1 on this data, so it demotes as often as promotes.
//
// Kept, wired, and switchable (ADA_MEMORY_RERANK=1) because the measurement is worth preserving and
// a better reranker or a larger ledger could flip it. It costs nothing while off — rerank() returns
// its input before touching a model, so no download and no latency.
//
// Fails OPEN like every other stage here: no model, slow CPU, timeout → the fused order stands and
// the turn is never blocked. Measured warm latency: ~44ms for 12 candidates; ~950ms on first load.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * bge-reranker pairs with the bge bi-encoder and, unlike the obvious default, actually works here.
 * Measured on 10 probes against 11 distractors: ms-marco-MiniLM-L-6 put the correct fact first 3/10
 * with a median margin of -0.05 (the best distractor usually WON), while bge-reranker-base got 6/10
 * at +2.80. ms-marco is trained on web-search passages; terse workplace assertions are far enough
 * out of that domain that it actively misranks them.
 */
const MODEL = process.env.ADA_MEMORY_RERANK_MODEL || "Xenova/bge-reranker-base";
/** Candidates to rerank. Cost is linear in this, and fusion rarely surfaces more than a handful
 *  worth reordering — past ~12 we are paying a forward pass to re-sort facts that will not be
 *  injected anyway. */
const TOP_K = Number(process.env.ADA_MEMORY_RERANK_K) || 12;
const BUDGET_MS = Number(process.env.ADA_MEMORY_RERANK_MS) || 2500;

export const rerankEnabled = (): boolean => process.env.ADA_MEMORY_RERANK === "1";

type Ranker = (query: string, docs: string[]) => Promise<number[]>;
let rankerP: Promise<Ranker> | null = null;

async function getRanker(): Promise<Ranker> {
  if (!rankerP) {
    rankerP = (async () => {
      const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
      env.cacheDir = process.env.ADA_MODEL_DIR || join(homedir(), ".ada", "models"); // same cache as the embedders
      env.allowRemoteModels = true;
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL),
        AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: "q8" }),
      ]);
      return async (query: string, docs: string[]): Promise<number[]> => {
        // One batched pass over [query, doc] pairs. Heads differ by model: most rerankers emit a
        // single relevance logit, some emit [irrelevant, relevant] — reading index 0 on the latter
        // would invert the ranking, so pick the last column either way. Higher is better; the scale
        // is arbitrary and only ever used to SORT.
        const inputs = tokenizer(new Array(docs.length).fill(query), { text_pair: docs, padding: true, truncation: true });
        const { logits } = await model(inputs);
        return (logits.tolist() as number[][]).map((row) => row[row.length - 1]!);
      };
    })().catch((e) => {
      rankerP = null; // let a later call retry
      throw e;
    });
  }
  return rankerP;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  const safe = p.catch(() => null);
  try {
    return await Promise.race([safe, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reorder `items` by cross-encoder relevance to `query`, best first.
 *
 * Only the first TOP_K are rescored; anything past that keeps its fused order and stays behind the
 * reranked head — a candidate fusion ranked 13th was not going to be injected either way, so paying
 * a forward pass for it buys nothing.
 * Returns the input untouched on any failure, so a caller can use the result unconditionally.
 */
export async function rerank<T>(query: string, items: T[], textOf: (t: T) => string): Promise<T[]> {
  if (!rerankEnabled() || items.length < 2) return items;
  const head = items.slice(0, TOP_K);
  const tail = items.slice(TOP_K);
  let scores: number[] | null = null;
  try {
    scores = await withTimeout(getRanker().then((r) => r(query, head.map(textOf))), BUDGET_MS);
  } catch {
    return items;
  }
  if (!scores || scores.length !== head.length) return items;
  const ordered = head.map((item, i) => ({ item, s: scores[i]! })).sort((a, b) => b.s - a.s).map((x) => x.item);
  return [...ordered, ...tail];
}
