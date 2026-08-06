// The two LLM passes over auto-memory:
//
//   1. EXTRACT — every N turns, read the recent transcript and write down what is durable. Without
//      this, ada only learns when the model remembers to call remember_fact, which in practice is
//      almost never (a months-old global ledger with one fact in it).
//   2. JUDGE — on write, compare the new fact against the ones it actually resembles and decide
//      store / skip / update / merge. Replaces the first-two-tokens subject-key heuristic, which
//      misses any rewording ("we deploy from main" vs "deployment happens on the release branch")
//      and so lets two contradictory facts both stay live and both get injected.
//
// Both are best-effort and non-blocking: a dead provider, a truncated reply or unparseable JSON
// leaves the ledger exactly as it was. Extraction is fire-and-forget after a turn, never before it.
//
// ponytail: two prompts and one cheap model. No background pipeline, no scheduler, no scene/persona
// layers — the recall budget is 7 facts, so distilling further has nothing to spend itself on.

import type OpenAI from "openai";
import { type MemScope, type MemType, type Memory, embedItems, loadMemories, rankMemories, rememberFact } from "./memory.ts";
import { ensureVectors, semanticScores } from "./memory-vec.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const LEARN_EVERY = Number(process.env.ADA_MEMORY_LEARN_EVERY) || 6; // turns between extraction passes
export const AUTO_LEARN = process.env.ADA_MEMORY_AUTO !== "0";
const JUDGE = process.env.ADA_MEMORY_JUDGE !== "0";
/** A pass that "finds" ten durable facts usually summarized the chat instead of mining it — but 3
 *  was too tight: bench/extraction.ts's dense-session case (a user dumping five conventions at once)
 *  capped at 53-80% recall purely on this limit, and a context dump is exactly when the user is
 *  telling you the most. Precision is the prompt's job and the judge's, not this number's. */
export const MAX_PER_PASS = 6;
const CANDIDATES = 5; // existing facts shown to the judge
/**
 * Candidate floor for the judge — deliberately LOWER than recall's SIM_FLOOR.
 * The two paths want opposite things. Recall needs precision: a wrongly injected fact wastes tokens
 * and misleads the model, so it only takes confident matches. The judge needs *recall*: it IS the
 * precision filter, so one extra candidate costs ~30 tokens while a missed one becomes a permanent
 * duplicate that nothing later cleans up.
 * Measured on real pairs: a true paraphrase scored 0.327 (just under recall's floor — this is the
 * bug), while unrelated facts sat at 0.03–0.07. 0.20 lands in that gap.
 */
const JUDGE_SIM = Number(process.env.ADA_MEMORY_JUDGE_SIM) || 0.2;
const INPUT_MAX = 12_000;
const CALL_MS = 30_000;

// ---- prompts ----

const EXTRACT_SYSTEM = `You read a slice of a coding session and write down ONLY what is still true, and still useful, months from now.

Extract at most ${MAX_PER_PASS} facts. Fewer is better. Zero is a correct and common answer.

Extract:
- a user preference stated as a standing rule ("always X", "I prefer Y", "never Z")
- a project convention or constraint ("we deploy from the release branch", "migrations need sign-off")
- a decision with lasting effect and its reason
- a gotcha that cost time and would cost it again

Do NOT extract:
- what happened this session, what the assistant did, or what is being worked on now (transient)
- anything phrased as a one-off request rather than a standing rule
- restatements of a file's contents, or anything that reads like documentation
- credentials, keys, tokens, passwords, or any value that looks random

TWO TESTS. Apply both to every candidate; failing either means skip it.

1. THE CALENDAR TEST — will this still be true next month?
   An instruction can sound absolutely binding and still expire. "For this refactor, keep the old API
   around", "don't touch the billing module today", "while we're in here, skip the tests", "leave it
   for now until v3 ships" are all scoped to a moment. They are the loudest sentences in the
   transcript and none of them are memories. Scope markers to watch for: for this / today / for now /
   while we're / until X / this time / mid-migration.
   "Always run the linter before committing" passes. "Don't run the linter until this branch merges"
   does not.

2. THE QUOTE TEST — could you point at the line where the user said this?
   Write down what they SAID, not what it implies. A session where a Windows path bug gets fixed does
   NOT mean "the team supports Windows" or "paths should use path.join" — nobody said either. If you
   are supplying the reason, the pattern, or the lesson, you are inventing it. Frustration is not a
   fact: "third time this week" tells you nothing durable.

Each fact MUST be self-contained: it has to still make sense read on its own, months later, by someone
who never saw this conversation. "Use the new one" is worthless. "The test runner is vitest, not jest"
is a fact. Merge related statements into one fact rather than splitting them.

Reply with ONLY a JSON array, no prose, no code fence:
[{"text":"...","type":"preference|convention|decision|gotcha|fact","scope":"project|user"}]
scope: "user" = true of this person everywhere; "project" = true of this repo. When unsure, "project".
Nothing durable? Reply exactly: []`;

const JUDGE_SYSTEM = `You maintain a small memory ledger. A NEW fact has arrived and you are shown the EXISTING facts most similar to it. Decide what should happen.

"store"  — genuinely new information. Keep the new fact, change nothing else.
"skip"   — an existing fact already says this, or says it better. Nothing changes.
"update" — same subject, and the new fact is a later/more specific/corrective version. The old one(s) are retired.
"merge"  — complementary and non-contradictory. Fuse them into ONE richer fact.

Rules:
- Two facts about DIFFERENT subjects are never update/merge, however similar the wording. "never delete the prod database" and "never delete stale branches" are separate facts.
- A contradiction is an "update" (newer wins), not a "merge".
- For update/merge, "text" is the final wording that will replace everything in "targets" — self-contained, one sentence.
- For store/skip, "targets" is [] and "text" is the new fact unchanged.
- When genuinely unsure, choose "store". Keeping a near-duplicate is cheap; silently rewriting the wrong fact is not.

Reply with ONLY a JSON object, no prose, no code fence:
{"action":"store|skip|update|merge","targets":["id",...],"text":"..."}`;

// ---- plumbing ----

/** Tolerant JSON extraction: strip fences, take the first bracketed span, fall back on any failure. */
export function parseJson<T>(raw: string, fallback: T): T {
  const s = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
  const start = s.search(/[[{]/);
  if (start < 0) return fallback;
  const open = s[start]!;
  const end = s.lastIndexOf(open === "[" ? "]" : "}");
  if (end <= start) return fallback;
  try {
    return JSON.parse(s.slice(start, end + 1)) as T;
  } catch {
    return fallback;
  }
}

const TYPES = new Set(["preference", "convention", "decision", "gotcha", "fact", "reference"]);

/** Validate + clamp a raw extraction reply. Anything malformed is dropped, not repaired. */
export function parseFacts(raw: string): Array<{ text: string; type: MemType; scope?: MemScope }> {
  const arr = parseJson<unknown>(raw, []);
  if (!Array.isArray(arr)) return [];
  const out: Array<{ text: string; type: MemType; scope?: MemScope }> = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const text = typeof o?.text === "string" ? o.text.trim().replace(/\s+/g, " ") : "";
    // A "fact" long enough to be a paragraph is a summary of the session, which is exactly what
    // extraction must not produce.
    if (text.length < 8 || text.length > 240) continue;
    out.push({
      text,
      type: TYPES.has(String(o.type)) ? (o.type as MemType) : "fact",
      scope: o.scope === "user" || o.scope === "project" ? o.scope : undefined,
    });
    if (out.length >= MAX_PER_PASS) break;
  }
  return out;
}

export interface Judgment {
  action: "store" | "skip" | "update" | "merge";
  targets: string[];
  text: string;
}
/** Validate a judge reply against the ids actually offered — a hallucinated target can't retire a
 *  fact the judge was never shown. */
export function parseJudgment(raw: string, fallbackText: string, offered: Set<string>): Judgment {
  const o = parseJson<Record<string, unknown>>(raw, {});
  const action = ["store", "skip", "update", "merge"].includes(String(o.action)) ? (o.action as Judgment["action"]) : "store";
  const targets = (Array.isArray(o.targets) ? o.targets.map(String) : []).filter((id) => offered.has(id));
  const text = typeof o.text === "string" && o.text.trim().length >= 8 ? o.text.trim().replace(/\s+/g, " ") : fallbackText;
  // update/merge with nothing valid left to replace degrades to a plain store, never to a silent drop.
  if ((action === "update" || action === "merge") && !targets.length) return { action: "store", targets: [], text };
  return { action, targets, text };
}

async function ask(client: OpenAI, model: string, system: string, user: string): Promise<string> {
  // Streamed like compaction.ts: every provider adapter supports it, non-streaming does not.
  const stream = await client.chat.completions.create(
    { model, stream: true, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    { signal: AbortSignal.timeout(CALL_MS) },
  );
  let out = "";
  for await (const chunk of stream) out += chunk.choices[0]?.delta?.content ?? "";
  return out;
}

/** Flatten recent messages to plain text for the extractor. Tool bodies are dropped — durable facts
 *  come from what the user SAID, not from a file listing. */
function transcript(messages: Msg[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "tool" || m.role === "system") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (text.trim()) parts.push(`${m.role}: ${text}`);
  }
  const out = parts.join("\n\n");
  return out.length > INPUT_MAX ? out.slice(-INPUT_MAX) : out;
}

// ---- pass 1: extraction ----

/**
 * Read the recent transcript, store what is durable, and return the texts actually stored.
 * Every candidate still goes through rememberFact, so the secret gate, dedup and (when enabled) the
 * judge all apply exactly as they do to a model-initiated remember_fact call.
 */
export async function learnFromTranscript(client: OpenAI, model: string, messages: Msg[], includeProject: boolean): Promise<string[]> {
  const text = transcript(messages);
  if (text.length < 200) return []; // nothing said yet
  const facts = parseFacts(await ask(client, model, EXTRACT_SYSTEM, `${text}\n\n---\nWhat from the above is durable?`));
  const stored: string[] = [];
  for (const f of facts) {
    const r = await rememberSmart(client, model, { ...f, tags: ["auto"] }, includeProject);
    if (r.ok && !r.skipped) stored.push(r.memory.text);
  }
  return stored;
}

// ---- query expansion (HyDE) ----

const HYDE_SYSTEM = `Rewrite a question as the one-sentence note that would answer it, as it might appear in a team's handbook.

Do not answer from your own knowledge and do not hedge — invent a plausible, concrete statement. It exists only to be compared against real notes, so wording matters and truth does not.

"how do I containerize the app" -> "The project uses Docker for local development and builds."
"who gets paged at night" -> "On-call alerts are routed to the duty engineer."

Output only the sentence.`;

/**
 * Turn a question into a hypothetical answer, so the embedder compares statement-to-statement.
 * Bi-encoders are weakest exactly where our probes live: a short conversational question against a
 * short declarative fact. HyDE closes that gap by moving the query into the same shape as the corpus.
 * Returns "" on any failure — the caller falls back to the raw query.
 *
 * NOT wired into recall — reachable only from `bench/memory.ts --hyde`. It measured as the single
 * biggest quality win available (ledger 120: hit 75% -> 80-90%, MRR 0.53 -> 0.72-0.82), and it is
 * still not shipped, for three reasons:
 *   1. It costs a BLOCKING model call before every turn's recall. Extraction is fire-and-forget every
 *      6 turns; this would be on the hot path of all of them.
 *   2. It breaks the cost-free-until-relevant guarantee — 3-4 of 8 off-topic probes started injecting
 *      facts, because inventing a confident answer for "what is the capital of Portugal" produces a
 *      sentence that genuinely resembles some unrelated note. Raising the floor to 0.56 did not fix it.
 *   3. The expansion is sampled, so the same config scored 80% on one run and 90% on the next. Any
 *      future tuning needs repeated runs, not the single-shot comparisons used elsewhere here.
 * Wiring it would mean a setQueryExpander hook alongside setSmartWriter, and a floor re-calibrated
 * for expanded queries.
 */
export async function expandQuery(client: OpenAI, model: string, query: string): Promise<string> {
  if (query.trim().length < 8) return "";
  try {
    const out = (await ask(client, model, HYDE_SYSTEM, query)).trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "");
    return out.length > 8 && out.length < 300 ? out : "";
  } catch {
    return "";
  }
}

// ---- pass 2: judged write ----

/** The CANDIDATES existing facts most similar to `text`, by lexical rank blended with cosine. */
async function similarTo(text: string, includeProject: boolean): Promise<Memory[]> {
  const mems = loadMemories(includeProject);
  if (!mems.length) return [];
  const lex = rankMemories(text, mems).slice(0, CANDIDATES);
  const items = embedItems(mems); // same enrichment as recall, or the two would use different caches
  await ensureVectors(items); // a fact stored seconds ago must still be comparable
  const sem = await semanticScores(text, items);
  const byId = new Map(mems.map((m) => [m.id, m]));
  const picked = new Map<string, Memory>();
  for (const r of lex) picked.set(r.m.id, r.m);
  for (const [id, score] of [...sem.entries()].sort((a, b) => b[1] - a[1])) {
    if (score < JUDGE_SIM || picked.size >= CANDIDATES * 2) break;
    const m = byId.get(id);
    if (m) picked.set(id, m);
  }
  return [...picked.values()].slice(0, CANDIDATES);
}

/**
 * Write a fact, letting the model resolve it against what is already stored. Falls back to the
 * plain deterministic rememberFact whenever the judge is disabled, has nothing to compare against,
 * or fails — so a write never depends on a model call succeeding.
 */
export async function rememberSmart(
  client: OpenAI,
  model: string,
  input: { text: string; scope?: MemScope; type?: MemType; tags?: string[]; body?: string },
  includeProject: boolean,
): Promise<{ ok: true; memory: Memory; skipped?: boolean; superseded?: string } | { ok: false; reason: string }> {
  if (!JUDGE) return rememberFact(input);
  let candidates: Memory[] = [];
  try {
    candidates = await similarTo(input.text, includeProject);
  } catch {
    /* recall failed — fall through to the deterministic write */
  }
  if (!candidates.length) return rememberFact(input);

  const offered = new Set(candidates.map((m) => m.id));
  let j: Judgment;
  try {
    const listing = candidates.map((m) => `${m.id}: ${m.text}`).join("\n");
    j = parseJudgment(await ask(client, model, JUDGE_SYSTEM, `NEW:\n${input.text}\n\nEXISTING:\n${listing}`), input.text, offered);
  } catch {
    return rememberFact(input);
  }

  if (j.action === "skip") {
    const keep = candidates[0]!;
    return { ok: true, memory: keep, skipped: true };
  }
  if (j.action === "store") return rememberFact(input);
  // update / merge: the judge's wording replaces every target it named.
  return rememberFact({ ...input, text: j.text, supersedes: j.targets });
}
