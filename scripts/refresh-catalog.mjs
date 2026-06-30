#!/usr/bin/env node
// Refresh ada's curated offline model catalog (src/client/catalog.json) from models.dev.
//
// We do NOT hand-maintain prices — models.dev is the community-maintained source of truth, and prices
// rot fast. This snapshots a curated *subset* (the popular providers in ALLOW below) so ada has
// accurate pricing/context limits offline and sane defaults, while still preferring live models.dev
// at runtime. Maintenance = edit ALLOW, then:  npm run catalog:refresh
//
//   node scripts/refresh-catalog.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The "popular services" we bake in. models.dev provider ids (see https://models.dev/api.json).
const ALLOW = [
  "anthropic",
  "openai",
  "google",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "deepseek",
  "xai",
  "mistral",
  "groq",
  "openrouter",
  "togetherai",
  "alibaba",
];

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "catalog.json");

const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`models.dev fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();

const providers = {};
let providerCount = 0;
let modelCount = 0;
for (const id of ALLOW) {
  const p = data[id];
  if (!p) {
    console.error(`  (skip) ${id}: not found in models.dev`);
    continue;
  }
  const models = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    const e = {
      name: m.name ?? mid,
      context: m.limit?.context ?? null,
      output: m.limit?.output ?? null,
      in: m.cost?.input ?? null, // $ / 1M input tokens
      out: m.cost?.output ?? null, // $ / 1M output tokens
      reasoning: !!m.reasoning,
    };
    if (m.cost?.cache_read != null) e.cacheRead = m.cost.cache_read;
    if (m.tool_call != null) e.toolCall = !!m.tool_call;
    models[mid] = e;
    modelCount++;
  }
  providers[id] = { name: p.name ?? id, npm: p.npm ?? undefined, models };
  providerCount++;
}

const json = { _note: "GENERATED from models.dev — do not edit by hand; run `npm run catalog:refresh`", providers };
writeFileSync(OUT, `${JSON.stringify(json)}\n`);
console.log(`wrote ${OUT}\n${providerCount} providers, ${modelCount} models`);
