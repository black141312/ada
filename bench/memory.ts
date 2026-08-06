#!/usr/bin/env node
// Auto-memory recall eval. Answers one question: when a fact was stored long ago and the user asks
// about it in different words, does it still get injected — and does that survive a ledger that has
// grown large?
//
//   npx tsx bench/memory.ts                      # both arms, all ledger sizes
//   npx tsx bench/memory.ts --arm hybrid         # one arm
//   npx tsx bench/memory.ts --sizes 20,120       # one or more ledger sizes
//   npx tsx bench/memory.ts --selftest           # offline checks of the pure helpers
//
// No API key and no backend needed: this evaluates RETRIEVAL, which makes no LLM calls. The hybrid
// arm runs the local embedder (first run downloads ~25MB). Extraction quality is a separate axis and
// is not measured here.
//
// Method. Every probe is a PARAPHRASE with deliberately low token overlap with its fact — "how do I
// containerize the app" for "we use Docker for local development". That is the case the old lexical
// ranker could not serve, so it is the case worth measuring. Distractor facts are then added to put
// the K=7 / 1800-char budget under real pressure, and the sweep shows where recall starts to break.
//
// ponytail: 20 cases and a fixed distractor pool, scored in-process. No dataset download, no harness,
// no judge model — the ground truth here is "is this exact fact id in the block", which is decidable.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- fixtures -----------------------------------------------------------------------------------

/** fact = what gets stored; probe = how a user asks about it 30 turns later, in their own words. */
const CASES: Array<{ fact: string; probe: string }> = [
  { fact: "We use Docker for local development", probe: "how do I containerize the app" },
  { fact: "The test runner is vitest, not jest", probe: "which framework runs the unit specs" },
  { fact: "Deployments go out from the release branch, never from main", probe: "where do we ship production from" },
  { fact: "Never run destructive migrations without ops sign-off", probe: "can I drop a column in prod" },
  { fact: "Answers should be terse, with no preamble", probe: "keep it brief please" },
  { fact: "API keys live in 1Password, never in .env files", probe: "where are credentials kept" },
  { fact: "The staging environment resets every night at 02:00 UTC", probe: "why did my sandbox data disappear overnight" },
  { fact: "The frontend uses Tailwind, not styled-components", probe: "how should I style this button" },
  { fact: "Standup is at 9:45am on Zoom", probe: "when is the daily sync" },
  { fact: "Postgres is the primary datastore; Redis is only a cache", probe: "can I persist this in redis" },
  { fact: "Pull requests need two approvals before merge", probe: "how many reviewers do I need" },
  { fact: "The build fails if type coverage drops below 95 percent", probe: "why is CI complaining about types" },
  { fact: "Logs are shipped to Datadog and retained for 30 days", probe: "where can I see last week's errors" },
  { fact: "We target Node 22 and cannot use newer syntax", probe: "is the latest javascript feature available" },
  { fact: "Feature flags are managed in LaunchDarkly", probe: "how do I gate a rollout" },
  { fact: "The monorepo uses pnpm workspaces", probe: "which package manager should I install with" },
  { fact: "Customer data must stay in the EU region", probe: "can we replicate to us-east" },
  { fact: "Alerts page the on-call engineer through PagerDuty", probe: "who gets woken up when it breaks" },
  { fact: "The design system components live in packages/ui", probe: "where do shared widgets go" },
  { fact: "Database migrations run automatically on deploy", probe: "do I need to apply schema changes manually" },
];

/** Queries about nothing in the ledger. These MUST inject zero facts — that is the
 *  cost-free-until-relevant guarantee, and it is the thing a looser threshold would break first. */
const OFF_TOPIC = [
  "quantum chromodynamics lunch menu roster",
  "what is the capital of Portugal",
  "write me a haiku about otters",
  "explain the offside rule",
  "who won the 1998 world cup",
  "recommend a pasta recipe",
  "translate hello into Finnish",
  "what year did the Beatles break up",
];

const DISTRACTOR_SEEDS = [
  "The office wifi password rotates every quarter",
  "Invoices are processed on the last Friday of the month",
  "The kitchen restocks oat milk on Tuesdays",
  "Parking badges are issued by facilities",
  "The all-hands happens monthly",
  "Expense reports go through Expensify",
  "New laptops ship from the Dublin office",
  "The support inbox is triaged twice a day",
  "Contractors sign a separate NDA",
  "The company retreat is in September",
  "Headcount planning runs on a quarterly cycle",
  "The legal team reviews all vendor contracts",
  "Onboarding buddies are assigned on day one",
  "The reception desk closes at 6pm",
  "Printer toner is ordered by the office manager",
  "Health insurance renews in January",
  "The mailing list is managed in Google Groups",
  "Desk moves happen on Fridays",
  "Visitor badges expire after 24 hours",
  "The gym reimbursement is capped annually",
];

/** Filler that is plausible but unrelated to every probe — enough of it to pressure the budget. */
function distractors(n: number): string[] {
  const out = [...DISTRACTOR_SEEDS];
  const owners = ["billing", "search", "notifications", "identity", "reporting", "ingest", "media", "pricing", "catalog", "audit"];
  const things = ["queue", "cron job", "dashboard", "webhook", "export", "retry policy", "rate limiter", "archive", "digest", "scheduler"];
  for (const o of owners) for (const t of things) out.push(`The ${o} team owns the ${t}`);
  return out.slice(0, n);
}

// --- scoring ------------------------------------------------------------------------------------

export interface Score {
  n: number;
  hits: number;
  rankSum: number; // 1-based rank of the target among injected facts, summed over hits
  injectedSum: number;
  falsePositives: number; // off-topic probes that injected anything
  offTopic: number;
}

export function summarize(s: Score): { hit: string; mrr: string; injected: string; noise: string } {
  return {
    hit: `${((s.hits / Math.max(1, s.n)) * 100).toFixed(0)}%`,
    // Mean reciprocal rank over ALL cases (a miss contributes 0) — rewards ranking the target first,
    // not merely squeezing it in under the budget.
    mrr: (s.hits ? s.rankSum / Math.max(1, s.n) : 0).toFixed(2),
    injected: (s.injectedSum / Math.max(1, s.n)).toFixed(1),
    noise: `${s.falsePositives}/${s.offTopic}`,
  };
}

// --- runner -------------------------------------------------------------------------------------

async function runArm(arm: "lexical" | "hybrid", size: number, dir: string): Promise<Score> {
  process.env.ADA_MEMORY_DIR = dir;
  process.env.ADA_MEMORY_SEMANTIC = arm === "hybrid" ? "1" : "0";
  process.env.ADA_MEMORY_EMBED_MS = "60000"; // no hot-path budget in a benchmark — measure quality, not latency

  const mem = await import("../src/client/memory.ts");
  const vec = await import("../src/client/memory-vec.ts");
  vec.resetVectorCache();

  // Fresh ledger per (arm, size). Everything is scope=project and non-preference so nothing lands in
  // the pinned/user-core carve-out and gets injected for free — that would score the wrong thing.
  rmSync(dir, { recursive: true, force: true });
  // Types are assigned round-robin from ONE pool to targets and distractors alike. They used to be
  // "convention" for every target and "fact" for every distractor, which is a leak the moment the
  // type is part of what gets embedded: the enrichment experiment would have been scoring a label
  // that perfectly separates the two groups and never occurs that way in a real ledger.
  const TYPE_POOL = ["convention", "decision", "gotcha", "fact"] as const;
  const targets = new Map<string, string>(); // probe -> memory id
  CASES.forEach((c, i) => {
    const r = mem.rememberFact({ text: c.fact, scope: "project", type: TYPE_POOL[i % TYPE_POOL.length] });
    if (!r.ok) throw new Error(`fixture refused: ${c.fact} (${r.reason})`);
    targets.set(c.probe, r.memory.id);
  });
  distractors(Math.max(0, size - CASES.length)).forEach((d, i) => {
    mem.rememberFact({ text: d, scope: "project", type: TYPE_POOL[i % TYPE_POOL.length] });
  });

  const all = mem.loadMemories(true);
  if (arm === "hybrid") await vec.ensureVectors(mem.embedItems(all), 300_000); // embed the whole ledger before probing

  // --hyde: expand each probe into a hypothetical fact before retrieving, so the embedder compares
  // statement-to-statement instead of question-to-statement. Needs a running ada-server; costs one
  // cheap model call per probe, which is the whole question — is it worth a call on every turn?
  const expand = process.argv.includes("--hyde") ? await hydeMap() : null;

  const s: Score = { n: CASES.length, hits: 0, rankSum: 0, injectedSum: 0, falsePositives: 0, offTopic: OFF_TOPIC.length };
  for (const c of CASES) {
    await mem.recallBlock(expand?.get(c.probe) ?? c.probe, true);
    const injected = mem.lastInjected();
    s.injectedSum += injected.length;
    const at = injected.findIndex((i) => i.id === targets.get(c.probe));
    if (at >= 0) {
      s.hits++;
      s.rankSum += 1 / (at + 1);
    }
  }
  // Off-topic probes get expanded too — otherwise HyDE would be scored on recall while being spared
  // the noise it creates, and inventing a confident fact for an unrelated question is exactly where
  // it should be most dangerous.
  for (const q of OFF_TOPIC) if (await mem.recallBlock(expand?.get(q) ?? q, true)) s.falsePositives++;
  return s;
}

/** probe -> "probe + hypothetical answer", precomputed once and shared across every arm and size. */
let hydeCache: Map<string, string> | null = null;
async function hydeMap(): Promise<Map<string, string>> {
  if (hydeCache) return hydeCache;
  const { default: OpenAI } = await import("openai");
  const { expandQuery } = await import("../src/client/memory-llm.ts");
  const client = new OpenAI({ baseURL: process.env.ADA_BACKEND_URL ?? "http://localhost:8787/v1", apiKey: process.env.ADA_CLIENT_KEY ?? "dev", maxRetries: 1 });
  const model = process.env.ADA_MEMORY_HYDE_MODEL ?? "deepseek/deepseek-v4-flash-0731";
  hydeCache = new Map();
  for (const q of [...CASES.map((c) => c.probe), ...OFF_TOPIC]) {
    const e = await expandQuery(client, model, q);
    // Keep the original text alongside the expansion: the lexical half still needs the user's own
    // words, and dropping them would measure HyDE-instead-of rather than HyDE-in-addition-to.
    hydeCache.set(q, e ? `${q} ${e}` : q);
  }
  return hydeCache;
}

/**
 * Threshold calibration. Prints, for every probe, the cosine against its OWN fact versus the best
 * cosine against any other fact — plus the same for the off-topic controls. The gap between those
 * two distributions is the only honest basis for picking SIM_FLOOR; a floor guessed from one or two
 * examples will sit in the middle of the signal and silently drop most true matches.
 */
async function calibrate(dir: string): Promise<void> {
  process.env.ADA_MEMORY_DIR = dir;
  rmSync(dir, { recursive: true, force: true });
  const { embedLocal } = await import("../src/client/embed-local.ts");
  const facts = [...CASES.map((c) => c.fact), ...distractors(100)];
  const F = await embedLocal(facts);
  const P = await embedLocal(CASES.map((c) => c.probe));
  const O = await embedLocal(OFF_TOPIC);
  const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

  const truePos: number[] = [];
  const nearMiss: number[] = [];
  for (let i = 0; i < CASES.length; i++) {
    truePos.push(dot(P[i]!, F[i]!));
    nearMiss.push(Math.max(...F.map((f, j) => (j === i ? -1 : dot(P[i]!, f)))));
  }
  const offMax = O.map((o) => Math.max(...F.map((f) => dot(o, f))));
  const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)]!;

  console.log("cosine distributions\n");
  console.log("                              min    p10    p50    p90    max");
  const row = (label: string, a: number[]): void =>
    console.log(`${label.padEnd(28)}${pct(a, 0).toFixed(2).padStart(5)}  ${pct(a, 0.1).toFixed(2).padStart(5)}  ${pct(a, 0.5).toFixed(2).padStart(5)}  ${pct(a, 0.9).toFixed(2).padStart(5)}  ${pct(a, 1).toFixed(2).padStart(5)}`);
  row("probe → its own fact", truePos);
  row("probe → best other fact", nearMiss);
  row("off-topic → best fact", offMax);

  // Absolute cosine and RANK are different questions. If the target is reliably the top-ranked fact
  // but its raw cosine is compressed into the same band as everything else, then gating on an
  // absolute floor is the wrong design and a top-N gate (fused by RRF) is the right one.
  const ranks = CASES.map((_, i) => {
    const scores = F.map((f, j) => ({ j, s: dot(P[i]!, f) })).sort((a, b) => b.s - a.s);
    return scores.findIndex((x) => x.j === i) + 1;
  });
  console.log(`\nrank of the target among all ${facts.length} facts, by cosine:`);
  for (const k of [1, 3, 5, 10, 20]) console.log(`  top-${String(k).padEnd(2)}  ${ranks.filter((r) => r <= k).length}/${CASES.length}`);
  console.log(`  median rank ${pct(ranks, 0.5)}`);

  console.log("\nfloor   recall   false-positives (off-topic probes that would match)");
  for (const f of [0.2, 0.25, 0.28, 0.3, 0.32, 0.35, 0.4]) {
    const rec = truePos.filter((t) => t >= f).length;
    const fp = offMax.filter((o) => o >= f).length;
    console.log(`${f.toFixed(2)}    ${String(rec).padStart(2)}/${CASES.length}    ${fp}/${OFF_TOPIC.length}${f === 0.35 ? "   <- current SIM_FLOOR" : ""}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Candidate embedders. MiniLM is a symmetric sentence-similarity model — it was trained to score
 * "are these two sentences alike", not "does this passage answer this query", which is why its
 * cosines came out flat on short-question/long-fact pairs. The rest are retrieval-tuned, and the
 * asymmetric ones want their query and passage sides prefixed differently; getting that wrong
 * measurably costs recall, so the prefixes are part of the model definition here.
 */
const EMBEDDERS: Array<{ id: string; q: string; d: string; note: string }> = [
  { id: "Xenova/all-MiniLM-L6-v2", q: "", d: "", note: "current — symmetric similarity" },
  { id: "Xenova/gte-small", q: "", d: "", note: "retrieval-tuned, no prefix" },
  { id: "Xenova/bge-small-en-v1.5", q: "Represent this sentence for searching relevant passages: ", d: "", note: "retrieval-tuned, asymmetric" },
  { id: "Xenova/bge-base-en-v1.5", q: "Represent this sentence for searching relevant passages: ", d: "", note: "768-dim, ~110MB" },
  { id: "Xenova/e5-small-v2", q: "query: ", d: "passage: ", note: "retrieval-tuned, asymmetric" },
];

/** Rank the target fact for every probe under each candidate model. Rank is the metric that matters:
 *  rankHybrid decides relevance by position, not by raw cosine. */
async function compareModels(): Promise<void> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = process.env.ADA_MODEL_DIR || join(process.env.USERPROFILE || process.env.HOME || ".", ".ada", "models");
  env.allowRemoteModels = true;
  const facts = [...CASES.map((c) => c.fact), ...distractors(100)];
  const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);
  const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)]!;

  console.log(`ranking the target among ${facts.length} facts, ${CASES.length} paraphrase probes\n`);
  console.log("model                          top-1  top-3  top-5  median  true_p50  offtopic_p90  note");
  console.log("-----------------------------  -----  -----  -----  ------  --------  ------------  ----");
  for (const m of EMBEDDERS) {
    let line: string;
    try {
      const pipe = (await pipeline("feature-extraction", m.id, { dtype: "q8" })) as unknown as (
        t: string[],
        o: { pooling: "mean"; normalize: boolean },
      ) => Promise<{ tolist(): number[][] }>;
      // ONE call for the whole set, exactly as embedLocal does. Batching is not neutral at q8: with
      // different padding lengths the quantized activations differ slightly, which reshuffles
      // near-ties in the ranking. Chunking here produced a different top-3 for the same model than
      // production did — so the comparison has to embed the way production embeds, or it is measuring
      // the batch size as much as the model.
      const embed = async (texts: string[]): Promise<number[][]> => (await pipe(texts, { pooling: "mean", normalize: true })).tolist();
      const F = await embed(facts.map((f) => m.d + f));
      const P = await embed(CASES.map((c) => m.q + c.probe));
      const O = await embed(OFF_TOPIC.map((o) => m.q + o));
      const ranks = CASES.map((_, i) => F.map((f, j) => ({ j, s: dot(P[i]!, f) })).sort((a, b) => b.s - a.s).findIndex((x) => x.j === i) + 1);
      const truePos = CASES.map((_, i) => dot(P[i]!, F[i]!));
      const offMax = O.map((o) => Math.max(...F.map((f) => dot(o, f))));
      const at = (k: number): string => `${ranks.filter((r) => r <= k).length}/${CASES.length}`;
      line = `${m.id.padEnd(29)}  ${at(1).padStart(5)}  ${at(3).padStart(5)}  ${at(5).padStart(5)}  ${String(pct(ranks, 0.5)).padStart(6)}  ${pct(truePos, 0.5).toFixed(2).padStart(8)}  ${pct(offMax, 0.9).toFixed(2).padStart(12)}  ${m.note}`;
    } catch (e) {
      line = `${m.id.padEnd(29)}  unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`;
    }
    console.log(line);
  }
  console.log("\ntop-N       = target ranked in the top N by cosine (higher is better — this drives rankHybrid)");
  console.log("true_p50    = median cosine to the correct fact");
  console.log("offtopic_p90 = what an unrelated query scores; the noise floor must sit above it");
}

function parseArgs(argv: string[]): { arms: Array<"lexical" | "hybrid">; sizes: number[]; selftest: boolean } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arm = get("--arm");
  return {
    arms: arm === "lexical" || arm === "hybrid" ? [arm] : ["lexical", "hybrid"],
    sizes: (get("--sizes") ?? "20,40,70,120").split(",").map(Number).filter((n) => n >= CASES.length),
    selftest: argv.includes("--selftest"),
  };
}

async function main(): Promise<void> {
  const { arms, sizes, selftest } = parseArgs(process.argv.slice(2));

  if (selftest) {
    // Pure helpers only — no model, no disk.
    assert.equal(CASES.length, 20, "20 probe cases");
    assert.equal(new Set(CASES.map((c) => c.fact)).size, CASES.length, "fact fixtures are distinct");
    assert.equal(new Set(CASES.map((c) => c.probe)).size, CASES.length, "probe fixtures are distinct");
    assert.ok(distractors(120).length === 120 && new Set(distractors(120)).size === 120, "distractors are distinct");
    for (const c of CASES) {
      // The whole point of the eval: probes must NOT share the fact's distinctive words, or the old
      // lexical ranker would pass trivially and the measurement would mean nothing.
      const f = new Set(c.fact.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3));
      const shared = c.probe.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3 && f.has(t));
      assert.ok(shared.length <= 1, `probe overlaps its fact too much (${shared.join(",")}): ${c.probe}`);
    }
    const s = summarize({ n: 10, hits: 5, rankSum: 2.5, injectedSum: 30, falsePositives: 1, offTopic: 8 });
    assert.equal(s.hit, "50%");
    assert.equal(s.mrr, "0.25");
    assert.equal(s.injected, "3.0");
    assert.equal(s.noise, "1/8");
    console.log("bench/memory selftest OK");
    return;
  }

  const dir = join(tmpdir(), `ada-bench-mem-${Date.now()}`);
  if (process.argv.includes("--compare-models")) {
    await compareModels();
    return;
  }
  if (process.argv.includes("--calibrate")) {
    await calibrate(dir);
    return;
  }
  const rows: string[] = [];
  try {
    console.log(`cases: ${CASES.length} paraphrase probes · off-topic controls: ${OFF_TOPIC.length}\n`);
    console.log("arm      ledger   hit    MRR   injected  noise");
    console.log("-------  ------   ----   ----  --------  -----");
    for (const arm of arms) {
      for (const size of sizes) {
        const r = summarize(await runArm(arm, size, dir));
        const line = `${arm.padEnd(7)}  ${String(size).padStart(6)}   ${r.hit.padStart(4)}   ${r.mrr}  ${r.injected.padStart(8)}  ${r.noise.padStart(5)}`;
        console.log(line);
        rows.push(line);
      }
    }
    console.log("\nhit      = target fact was injected for its paraphrased probe");
    console.log("MRR      = mean reciprocal rank of the target (1.00 = always ranked first)");
    console.log("injected = mean facts injected per probe (budget is K=7)");
    console.log("noise    = off-topic probes that injected anything (must be 0)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ADA_MEMORY_DIR;
    delete process.env.ADA_MEMORY_SEMANTIC;
    delete process.env.ADA_MEMORY_EMBED_MS;
  }
}

main().catch((e) => {
  console.error("bench/memory FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
