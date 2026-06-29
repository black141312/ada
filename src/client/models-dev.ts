// models.dev catalog — model metadata (context limits, pricing, capabilities). Prefetched once at
// startup and cached for an hour; reads are synchronous from the in-memory cache. Offline-safe:
// if the fetch fails, the cache stays empty and callers fall back to their own tables.

interface Info {
  context?: number;
  output?: number;
  inputCost?: number; // $ per 1M input tokens
  outputCost?: number; // $ per 1M output tokens
  reasoning?: boolean;
}

const cache = new Map<string, Info>();
let fetchedAt = 0;

/** Fetch and cache the models.dev catalog (no-op if fetched within the last hour). */
export async function prefetch(): Promise<void> {
  if (cache.size && Date.now() - fetchedAt < 3_600_000) return;
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, { models?: Record<string, { limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }; reasoning?: boolean }> }>;
    cache.clear();
    for (const prov of Object.values(data)) {
      for (const [id, m] of Object.entries(prov.models ?? {})) {
        cache.set(id, { context: m.limit?.context, output: m.limit?.output, inputCost: m.cost?.input, outputCost: m.cost?.output, reasoning: m.reasoning });
      }
    }
    fetchedAt = Date.now();
  } catch {
    /* offline — keep whatever's cached */
  }
}

function lookup(modelId: string): Info | null {
  return cache.get(modelId) ?? cache.get(modelId.split("/").pop() ?? "") ?? cache.get(modelId.split(":")[0] ?? "") ?? null;
}

/** [inputCostPer1M, outputCostPer1M] from models.dev, or null. */
export function priceOf(modelId: string): [number, number] | null {
  const i = lookup(modelId);
  return i && i.inputCost != null && i.outputCost != null ? [i.inputCost, i.outputCost] : null;
}

/** Context-window limit (tokens) from models.dev, or null. */
export function contextOf(modelId: string): number | null {
  return lookup(modelId)?.context ?? null;
}

export function catalogSize(): number {
  return cache.size;
}
