// Auto-memory: durable facts ada recalls automatically at the start of every turn. Storage is plain
// Markdown bullets (git-diffable, hand-editable) under .ada/memory/ (project, trusted-gated) and
// ~/.ada/memory/ (global). Recall blends the lexical ranker (skill-router.rankSkills — deterministic,
// offline, zero-dep) with cosine similarity from the local embedder (memory-vec.ts) by RRF, and rides
// agent.ts's per-turn transient system-note seam, so it's recomputed fresh each turn and NEVER
// persisted: context stays flat as the store grows.
//
// Measured by bench/memory.ts (20 paraphrase probes, ledger swept to 120 facts):
//   lexical only  25% hit, MRR 0.20   ·   hybrid  75% hit, MRR 0.53, 0/8 off-topic false positives
//
// Design guarantees (see selfcheck-memory.ts):
//   - cost-free-until-relevant: an off-topic turn injects zero facts on the lexical path (hard score
//     floor). The semantic half softens this to *nearly* zero — measured 1 off-topic probe in 8
//     injecting a single fact — which bought +30 points of hit rate. Stated plainly because it is a
//     deliberate trade, not an oversight: `ADA_MEMORY_SEMANTIC=0` restores the absolute guarantee;
//   - ranked-not-dumped + budget-capped (≤ K facts, ≤ char cap; drop whole facts, never truncate);
//   - ephemeral recall: a recall turn leaves the persistent message list unchanged;
//   - secret-safe: redactScan refuses secrets on EVERY write AND at load — a leaked value can't
//     enter context even via a hand-edit;
//   - supersede-not-duplicate: a same-subject value change retires the old fact (kept for git audit);
//   - lexical-only still works: semantic recall and the LLM judge (memory-llm.ts) are both additive.
//     With no model, no network or ADA_MEMORY_SEMANTIC=0, every guarantee above still holds.
//
// ponytail: the semantic half is a cosine over a cache of the SAME MiniLM vectors @codebase already
// builds — no new dependency, no vector DB, no index server.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rerank } from "./memory-rerank.ts";
import { SIM_FLOOR, semanticScores } from "./memory-vec.ts";
import { rankSkills, tokenize } from "./skill-router.ts";
import { registerTool } from "./tools.ts";

export type MemType = "preference" | "convention" | "decision" | "gotcha" | "fact" | "reference";
export type MemScope = "project" | "user";
export interface Memory {
  id: string;
  text: string;
  type: MemType;
  scope: MemScope;
  pin: boolean;
  tags: string[];
  added: string;
  used: string; // last WRITE (stored, edited, re-asserted)
  /** Last day this fact was auto-recalled. Separate from `used` on purpose: a fact written today
   *  already has used=today, so reusing it as the recall throttle would silently never count. */
  recalled: string;
  hits: number; // times auto-recalled (day-granular) + times re-asserted
  superseded?: string; // id that replaced this one — kept in the file for audit, excluded from recall
}

const K = Number(process.env.ADA_MEMORY_K) || 7; // max facts injected per turn
const CHAR_CAP = Number(process.env.ADA_MEMORY_CHARS) || 1800; // rough ~450-token ceiling on the block
const FLOOR = Number(process.env.ADA_MEMORY_FLOOR) || 1; // min lexical score for a fact to be recalled
const RRF_K = 60; // reciprocal-rank-fusion damping — the standard constant; ranks, not scores, so the
// lexical (unbounded idf sum) and semantic (0..1 cosine) scales never have to be reconciled.
/** How many facts the semantic half may nominate. The embedder ranks well but scores flat (see
 *  SIM_FLOOR), so the useful signal is "which few are closest", not "how close".
 *  Swept on bench/memory.ts at ledger 120: 1 → 65% hit, 3 → 65%, 5 → 70%, 8 → 75%, 12 → 75% (the
 *  noise floor caps it there anyway). Going 3 → 8 cost 0.8 more facts injected per turn and gained
 *  10 points of hit rate; lower N is more token-efficient if that trade ever stops being worth it. */
const SEM_TOPN = Number(process.env.ADA_MEMORY_SEM_TOPN) || 8;
/**
 * Fusion weights. Plain RRF weights both halves equally; these let one count for more — or, at 0,
 * not run at all, which is how bench/memory.ts measures each retriever in isolation.
 * Measured (ledger 120, topn 8): lexical alone 25% hit / MRR 0.20 · semantic alone 70% / 0.62 ·
 * equal 75% / 0.48 · semantic-doubled 75% / 0.53. Doubling the semantic half keeps the best hit rate
 * while recovering the ranking quality that equal weighting gave away, at no extra token cost.
 * Lexical stays in: alone it is weak, but it is free (no model, no latency) and worth +5 points.
 */
const W_LEX = process.env.ADA_MEMORY_W_LEX === undefined ? 1 : Number(process.env.ADA_MEMORY_W_LEX);
const W_SEM = process.env.ADA_MEMORY_W_SEM === undefined ? 2 : Number(process.env.ADA_MEMORY_W_SEM);
const TYPES = new Set<MemType>(["preference", "convention", "decision", "gotcha", "fact", "reference"]);

function memDir(scope: MemScope): string {
  // ADA_MEMORY_DIR relocates both scopes under one root (used by the selfcheck; also lets a user
  // move memory off the default .ada/~/.ada). Default: project = cwd/.ada, user = ~/.ada.
  const base = process.env.ADA_MEMORY_DIR;
  if (base) return resolve(base, scope);
  return scope === "user" ? resolve(homedir(), ".ada", "memory") : resolve(process.cwd(), ".ada", "memory");
}
const ledger = (scope: MemScope): string => join(memDir(scope), "memory.md");
const refFile = (scope: MemScope, id: string): string => join(memDir(scope), "ref", `${id}.md`);

function newId(): string {
  return `m${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

// ---- secret gate (refuse-on-suspicion; runs on every write AND at load) ----
const SECRET_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9-]{16,}/, // OpenAI / Anthropic (sk-ant-…) / OpenRouter (sk-or-…); \b so it can't start mid-word (disk-…, task-…)
  /AIza[0-9A-Za-z_-]{35}/, // Google / Gemini API key
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[opsu]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /ada_sk_[0-9a-f]{40,}/, // ada's own seat keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, // JWT
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S{4,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\bAuthorization\s*:\s*\S+/i,
];
function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
/** Refuse a fact that looks like it contains a secret — never store, not even redacted. */
export function redactScan(text: string): { ok: true } | { ok: false; reason: string } {
  for (const re of SECRET_RES) if (re.test(text)) return { ok: false, reason: "looks like a credential/secret" };
  // High-entropy "looks-random" run → likely a secret. Fires on ≥2 char classes (an all-caps+digits
  // or mixed key), gated by a low vowel ratio so long camelCase identifiers ("verifyBetterAuthSession")
  // and real words pass. Canonical benign ids (git SHAs, UUIDs) are exempt.
  for (const tok of text.split(/\s+/)) {
    if (tok.length < 20 || !/^[A-Za-z0-9+/=_-]+$/.test(tok)) continue;
    if (/^[0-9a-f]{7,8}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(tok)) continue; // git sha
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) continue; // uuid
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(tok)).length;
    const vowelRatio = (tok.match(/[aeiou]/gi) ?? []).length / tok.length;
    if (classes >= 2 && vowelRatio < 0.22 && shannon(tok) > 3.5) return { ok: false, reason: "high-entropy token (possible secret)" };
  }
  return { ok: true };
}

// ---- supersession subject key: first two content tokens identify "what this fact is about" ----
export function subjectKey(text: string): string {
  return tokenize(text).slice(0, 2).join(" ");
}
const normalize = (s: string): string => tokenize(s).join(" ");
/** Token Jaccard similarity — gates supersede so two facts that merely share a leading bigram
 *  ("never delete the prod db" vs "never delete stale branches") don't retire each other. */
function similar(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- parse / serialize (one bullet + HTML-comment metadata trailer) ----
function serialize(m: Memory): string {
  const meta = [`id=${m.id}`, `type=${m.type}`, `scope=${m.scope}`, `pin=${m.pin ? 1 : 0}`, `added=${m.added}`, `used=${m.used}`, `hits=${m.hits}`];
  if (m.recalled) meta.push(`recalled=${m.recalled}`);
  if (m.tags.length) meta.push(`tags=${m.tags.join(",")}`);
  if (m.superseded) meta.push(`superseded=${m.superseded}`);
  return `- ${m.text} <!-- ${meta.join(" ")} -->`;
}
function parseLine(line: string, scope: MemScope): Memory | null {
  const m = line.match(/^-\s+(.*)\s*<!--\s*([^]*?)\s*-->\s*$/); // greedy text → the LAST comment is the trailer
  if (!m) return null;
  const text = m[1]!.replace(/^~~|~~$/g, "").trim(); // tolerate ~~struck~~ hand-edits
  const meta: Record<string, string> = {};
  for (const kv of m[2]!.split(/\s+/)) {
    const i = kv.indexOf("=");
    if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1);
  }
  if (!meta.id || !text) return null;
  const type = TYPES.has(meta.type as MemType) ? (meta.type as MemType) : "fact";
  return {
    id: meta.id,
    text,
    type,
    scope,
    pin: meta.pin === "1",
    tags: meta.tags ? meta.tags.split(",").filter(Boolean) : [],
    added: meta.added ?? "",
    used: meta.used ?? "",
    recalled: meta.recalled ?? "", // absent in ledgers written before recall was tracked
    hits: Number(meta.hits) || 0,
    superseded: meta.superseded,
  };
}

/** Read a scope's ledger → live memories (drops superseded, and — the load-time secret gate — any
 *  line whose text matches a secret pattern, so a hand-edited leak can't reach context). */
function readScope(scope: MemScope): Memory[] {
  let text: string;
  try {
    text = readFileSync(ledger(scope), "utf8");
  } catch {
    return [];
  }
  const out: Memory[] = [];
  for (const line of text.split("\n")) {
    const m = parseLine(line.trim(), scope);
    if (!m || m.superseded) continue;
    if (!redactScan(m.text).ok) {
      console.error(`\x1b[33m[memory] skipped a stored line that matches a secret pattern (${scope})\x1b[0m`);
      continue;
    }
    out.push(m);
  }
  return out;
}

/** All live memories: global always, project only when the cwd is trusted. */
export function loadMemories(includeProject: boolean): Memory[] {
  return includeProject ? [...readScope("user"), ...readScope("project")] : readScope("user");
}

/** Rewrite a scope's whole ledger (edit/forget/consolidate). Small file; parse-tolerant on next read. */
function writeScope(scope: MemScope, all: Memory[]): void {
  mkdirSync(memDir(scope), { recursive: true });
  const header = "<!-- ada auto-memory. Bullets are hand-editable; the trailer is machine metadata. Deleting a line forgets it. -->\n\n";
  writeFileSync(ledger(scope), header + all.map(serialize).join("\n") + "\n");
}

/** Read ALL lines of a scope (incl. superseded) so a rewrite preserves audit history. */
function readScopeRaw(scope: MemScope): Memory[] {
  let text: string;
  try {
    text = readFileSync(ledger(scope), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").map((l) => parseLine(l.trim(), scope)).filter((m): m is Memory => !!m);
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** Append a fact (crash-safe single-line write), after the secret gate + dedup/supersede pass.
 *  Returns the stored memory, or null if refused (secret) — the caller surfaces the reason.
 *  `supersedes` retires specific ids explicitly (the LLM judge's update/merge verdict); when given
 *  it REPLACES the same-subject heuristic rather than adding to it — the judge saw the full text of
 *  every candidate, so a leading-bigram guess on top of that could only make the decision worse. */
export function rememberFact(input: { text: string; scope?: MemScope; type?: MemType; tags?: string[]; body?: string; supersedes?: string[] }): { ok: true; memory: Memory; superseded?: string } | { ok: false; reason: string } {
  const text = input.text.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, reason: "empty" };
  if (/<!--|-->/.test(text)) return { ok: false, reason: "fact text may not contain a comment marker" }; // would corrupt the ledger trailer
  const scan = redactScan(text + " " + (input.body ?? ""));
  if (!scan.ok) return { ok: false, reason: scan.reason };
  const scope: MemScope = input.scope ?? inferScope(text);
  const type: MemType = input.type && TYPES.has(input.type) ? input.type : "fact";

  const raw = readScopeRaw(scope);
  const subj = subjectKey(text);
  const norm = normalize(text);
  let supersededId: string | undefined;
  // dedup: an existing live line with (near-)identical text → NOOP, just bump hits.
  const dup = raw.find((m) => !m.superseded && normalize(m.text) === norm);
  if (dup) {
    dup.hits++;
    dup.used = today();
    writeScope(scope, raw);
    return { ok: true, memory: dup };
  }
  const m: Memory = { id: newId(), text, type, scope, pin: false, tags: input.tags ?? [], added: today(), used: today(), recalled: "", hits: 0 };
  if (input.supersedes?.length) {
    // Explicit (judged) retirement: many-to-one is allowed — one merged fact can replace several.
    const targets = new Set(input.supersedes);
    for (const x of raw) {
      if (x.superseded || !targets.has(x.id)) continue;
      x.superseded = m.id;
      supersededId = x.id;
      m.pin ||= x.pin; // a merge must not silently unpin what the user pinned
    }
  } else {
    // supersede: an existing live line about the SAME subject AND genuinely similar (a changed value),
    // not merely a shared leading bigram — so distinct safety facts are never silently retired.
    const same = raw.find((x) => !x.superseded && subj && subjectKey(x.text) === subj && normalize(x.text) !== norm && similar(x.text, text) >= 0.4);
    if (same) {
      same.superseded = m.id;
      supersededId = same.id;
    }
  }
  if (input.type === "reference" && input.body) {
    mkdirSync(join(memDir(scope), "ref"), { recursive: true });
    writeFileSync(refFile(scope, m.id), input.body);
  }
  raw.push(m);
  writeScope(scope, raw);
  try { onRemember?.(m.text); } catch { /* extraction is best-effort; a hook error never breaks remembering */ }
  return { ok: true, memory: m, superseded: supersededId };
}

// Optional side-effect run after each NEW fact is stored (the knowledge graph wires extraction here).
// A hook — not a direct import — keeps this module pure and offline-testable; default null = no-op.
let onRemember: ((fact: string) => void) | null = null;
export function setFactExtractor(fn: ((fact: string) => void) | null): void {
  onRemember = fn;
}

export type WriteInput = { text: string; scope?: MemScope; type?: MemType; tags?: string[]; body?: string };
export type WriteResult = { ok: true; memory: Memory; skipped?: boolean; superseded?: string } | { ok: false; reason: string };
// Optional judged-write path (memory-llm.rememberSmart). A hook, not an import, so memory.ts keeps
// no dependency on a model/client and stays offline-testable; null = the deterministic write.
let smartWrite: ((input: WriteInput) => Promise<WriteResult>) | null = null;
export function setSmartWriter(fn: ((input: WriteInput) => Promise<WriteResult>) | null): void {
  smartWrite = fn;
}

function inferScope(text: string): MemScope {
  const t = " " + text.toLowerCase() + " ";
  if (/\b(this repo|this project|here|we use|we deploy|our |in this codebase)\b/.test(t)) return "project";
  if (/\b(i always|i prefer|my name|i generally|i like|call me)\b/.test(t)) return "user";
  return "project"; // narrower by default when unsure
}

// ---- ranking / recall ----

/** Usage prior: a fact that keeps getting recalled, and was recalled recently, is slightly more
 *  likely to be the right one again. Deliberately small (≤ ~1.5x) — it reorders near-ties, it never
 *  outvotes relevance. Multiplicative on a score rankSkills only returns when > 0, so it can never
 *  lift an unmatched fact over FLOOR: the cost-free-until-relevant guarantee is unaffected. */
function usageBoost(m: Memory): number {
  let b = 1;
  if (m.hits > 0) b += 0.15 * Math.log2(1 + m.hits);
  const t = Date.parse(m.recalled || m.used);
  if (!Number.isNaN(t)) {
    const days = (Date.now() - t) / 86_400_000;
    if (days >= 0 && days <= 14) b += 0.1;
  }
  return b;
}

export function rankMemories(query: string, mems: Memory[]): { m: Memory; score: number }[] {
  const items = mems.map((m) => ({ name: [...m.tags, m.type].join(" "), description: m.text }));
  const ranked = rankSkills(query, items, items.length);
  // Same text can exist in both scopes; resolve each ranked entry to a DISTINCT memory (shift) so a
  // dup isn't emitted twice while its twin is shadowed.
  const byText = new Map<string, Memory[]>();
  for (const m of mems) {
    const a = byText.get(m.text);
    if (a) a.push(m);
    else byText.set(m.text, [m]);
  }
  const out: { m: Memory; score: number }[] = [];
  for (const r of ranked) {
    const m = byText.get(r.description)?.shift();
    if (m) out.push({ m, score: r.score * usageBoost(m) });
  }
  return out.sort((a, b) => b.score - a.score); // re-sort: the boost can reorder near-ties
}

/**
 * What actually gets embedded for a fact. Off by default: the lexical ranker boosts tags and type
 * 2.5x because token overlap on a label is cheap evidence, but an embedder reads the label as part
 * of a sentence, where a generic word like "convention" mostly adds noise to the vector.
 * Measured (ledger 120): hit unchanged at 75%, MRR 0.53 -> 0.56, but facts injected per turn 4.3 ->
 * 4.8. A third of a rank position for half a fact more in every prompt is not a trade worth taking
 * by default, and auto-extracted facts currently carry only the tag "auto" — so there is little real
 * tag signal to gain until the extractor emits meaningful ones.
 * Enable with ADA_MEMORY_EMBED_TAGS=1.
 */
const EMBED_ENRICH = process.env.ADA_MEMORY_EMBED_TAGS === "1";
export function embedItems(mems: Memory[]): Array<{ id: string; text: string }> {
  if (!EMBED_ENRICH) return mems.map((m) => ({ id: m.id, text: m.text }));
  // The enriched string IS the cache key, so flipping this flag (or editing a fact's tags)
  // re-embeds rather than silently comparing against a stale vector.
  return mems.map((m) => ({ id: m.id, text: m.tags.length ? `${m.type} (${m.tags.join(", ")}): ${m.text}` : `${m.type}: ${m.text}` }));
}

export interface Ranked {
  m: Memory;
  /** Fused rank score. Tiny by construction (~0.03 max) — compare it to other fused scores, nothing else. */
  score: number;
  lex: number; // lexical score, 0 when the lexical ranker didn't match at all
  sem: number; // cosine, 0 when semantic recall was unavailable or the fact wasn't cached yet
}

/**
 * Lexical ∪ semantic, fused by reciprocal rank. Two ranked lists over the same facts are combined as
 * sum(1 / (RRF_K + rank)) — rank-based, so an unbounded idf sum and a 0..1 cosine never need to be
 * put on a common scale, and neither half can dominate by having larger numbers.
 *
 * Semantic evidence is ADDITIVE: when it's unavailable (offline, model still downloading, disabled)
 * `sem` is 0 everywhere and this degrades to exactly the old lexical ordering.
 */
export async function rankHybrid(query: string, mems: Memory[]): Promise<Ranked[]> {
  const lex = rankMemories(query, mems);
  let sem = new Map<string, number>();
  try {
    sem = await semanticScores(query, embedItems(mems));
  } catch {
    /* semantic recall is best-effort — never fail a turn over it */
  }
  const semList = [...sem.entries()]
    .filter(([, s]) => s >= SIM_FLOOR) // screen out the noise band, not a relevance judgement
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEM_TOPN); // relevance IS the rank — take the closest few and let RRF weigh them

  const byId = new Map(mems.map((m) => [m.id, m]));
  const acc = new Map<string, Ranked>();
  const bump = (id: string, rank: number, field: "lex" | "sem", value: number, weight: number): void => {
    const m = byId.get(id);
    if (!m) return;
    const cur = acc.get(id) ?? { m, score: 0, lex: 0, sem: 0 };
    cur.score += weight / (RRF_K + rank);
    cur[field] = value;
    acc.set(id, cur);
  };
  // A zero-weight half is skipped entirely rather than scored at 0 — otherwise its candidates would
  // still land in `acc` and still pass the eligibility check downstream, just ranked last.
  if (W_LEX > 0) lex.forEach((r, i) => bump(r.m.id, i, "lex", r.score, W_LEX));
  if (W_SEM > 0) semList.forEach(([id, s], i) => bump(id, i, "sem", s, W_SEM));
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Record that these facts were used. Throttled to once per fact per day, so the hot path costs at
 *  most one small rewrite per scope per day and the ledger's git history stays readable. */
function touch(used: Memory[]): void {
  const day = today();
  const stale = used.filter((m) => m.recalled !== day);
  if (!stale.length) return;
  const ids = new Set(stale.map((m) => m.id));
  for (const scope of new Set(stale.map((m) => m.scope))) {
    try {
      const raw = readScopeRaw(scope);
      let dirty = false;
      for (const x of raw) {
        if (x.superseded || !ids.has(x.id)) continue;
        x.hits++;
        x.recalled = day;
        dirty = true;
      }
      if (dirty) writeScope(scope, raw);
    } catch {
      /* a read-only or vanished ledger must not break recall */
    }
  }
}

let _lastInjected: { id: string; score: number }[] = [];
export function lastInjected(): { id: string; score: number }[] {
  return _lastInjected;
}

/** The auto-recall block for a turn: pinned + small user-core facts always, then the highest-ranked
 *  relevant facts up to the budget. Null when nothing clears the floor (an off-topic turn = no cost). */
async function memoryBlock(query: string, includeProject: boolean): Promise<string | null> {
  const mems = loadMemories(includeProject);
  if (!mems.length) return null;
  const pinned = mems.filter((m) => m.pin);
  const core = mems.filter((m) => !m.pin && m.scope === "user" && m.type === "preference" && m.text.length < 120);
  const alwaysIds = new Set([...pinned, ...core].map((m) => m.id));
  const rest = mems.filter((m) => !alwaysIds.has(m.id));
  // Eligibility is per-signal and unchanged for the lexical half: a fact is recallable if the lexical
  // ranker clears FLOOR *or* the embedder clears SIM_FLOOR. Ordering among the eligible is the fused
  // rank. An off-topic query clears neither, so it still injects nothing.
  let ranked = (await rankHybrid(query, rest)).filter((r) => r.lex >= FLOOR || r.sem >= SIM_FLOOR);
  // Final stage: a cross-encoder rereads (query, fact) as one input and reorders the shortlist.
  // Eligibility is NOT revisited here — fusion decides what may be recalled, the reranker only
  // decides what comes first, so this can never widen recall past the floors above.
  // Rescored by POSITION after reranking, because the char-budget pass below re-sorts by `score` and
  // would otherwise throw the new order away and restore the fused one. When reranking is off or
  // failed this is a no-op reindex of an already-descending list.
  ranked = (await rerank(query, ranked, (r) => r.m.text)).map((r, i) => ({ ...r, score: 1 / (i + 1) }));

  const chosen: { m: Memory; score: number }[] = [...pinned, ...core].map((m) => ({ m, score: Infinity }));
  for (const r of ranked) {
    if (chosen.length >= K) break;
    chosen.push(r);
  }
  if (!chosen.length) return null;
  // char budget: keep highest-score first, drop whole low-score facts (never truncate a fact)
  chosen.sort((a, b) => b.score - a.score);
  const kept: { m: Memory; score: number }[] = [];
  let used = 0;
  for (const c of chosen) {
    const len = c.m.text.length + 4;
    if (kept.length && used + len > CHAR_CAP) continue;
    kept.push(c);
    used += len;
  }
  if (!kept.length) return null;
  // Fused scores live around 0.01–0.03; scale for display so `/memory why` isn't a column of "0.02".
  _lastInjected = kept.map((c) => ({ id: c.m.id, score: c.score === Infinity ? 999 : Math.round(c.score * 1000) / 10 }));
  touch(kept.map((c) => c.m));
  const lines = kept.map((c) => {
    const tail = c.m.pin ? "  [pinned]" : c.m.type === "reference" ? `  (reference — call recall({id:"${c.m.id}"}) for details)` : "";
    return `- ${c.m.text}${tail}`;
  });
  return `Relevant memories (auto-recalled from earlier sessions; use if helpful, ignore if not):\n${lines.join("\n")}`;
}

// Optional recall augmenter — the knowledge graph surfaces related facts here. A hook, not a direct
// import, so memory.ts stays pure and offline-testable; default null = flat recall only.
let recallAugment: ((query: string, includeProject: boolean) => string | null) | null = null;
export function setRecallAugmenter(fn: ((query: string, includeProject: boolean) => string | null) | null): void {
  recallAugment = fn;
}

/** Auto-recall for a turn: the relevant flat facts, plus any related facts the graph surfaces.
 *  Async only because of the semantic half, which is time-boxed inside semanticScores — this never
 *  waits on the network and never throws. */
export async function recallBlock(query: string, includeProject: boolean): Promise<string | null> {
  const mem = await memoryBlock(query, includeProject);
  const graph = recallAugment?.(query, includeProject) ?? null;
  if (!mem && !graph) return null;
  return [mem, graph].filter(Boolean).join("\n\n");
}

// ---- edit / forget / pin / consolidate ----
function mutate(scope: MemScope, fn: (all: Memory[]) => Memory[] | void): void {
  const all = readScopeRaw(scope);
  const next = fn(all);
  writeScope(scope, next ?? all);
}
function findAcross(idOrSubstr: string, includeProject: boolean): { scope: MemScope; m: Memory } | null {
  for (const scope of includeProject ? (["project", "user"] as MemScope[]) : (["user"] as MemScope[])) {
    const m = readScopeRaw(scope).find((x) => !x.superseded && (x.id === idOrSubstr || x.text.toLowerCase().includes(idOrSubstr.toLowerCase())));
    if (m) return { scope, m };
  }
  return null;
}

// ---- tools: remember_fact (capture) + recall (fetch a reference body) ----
export function registerMemoryTools(includeProject: boolean): void {
  registerTool({
    name: "remember_fact",
    description:
      "Save a durable fact to recall in later sessions — a user preference, project convention, decision, correction, or constraint ('always use X', 'we deploy via Y', 'my name is Z', 'never touch W'). Do NOT save transient task state, anything already in AGENTS.md/CLAUDE.md, or secrets/keys/tokens (those are refused).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "the durable fact, one sentence" },
        scope: { type: "string", enum: ["project", "user"], description: "project = this repo; user = you across all projects. Inferred if omitted." },
        type: { type: "string", enum: ["preference", "convention", "decision", "gotcha", "fact", "reference"] },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string", description: "only for type=reference: the full note (kept out of auto-recall; fetched via the recall tool)" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const input: WriteInput = {
        text: String(args.text ?? ""),
        scope: args.scope === "user" || args.scope === "project" ? args.scope : undefined,
        type: args.type as MemType | undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        body: args.body ? String(args.body) : undefined,
      };
      // Judged write when a model is wired (resolves this against the facts it resembles), plain
      // deterministic write otherwise. rememberSmart falls back to the same call on any failure.
      const r: WriteResult = smartWrite ? await smartWrite(input) : rememberFact(input);
      if (!r.ok) return { output: `refused: ${r.reason}`, display: `\x1b[33m⚠ not remembered: ${r.reason}\x1b[0m`, isError: false };
      if (r.skipped) return { output: "already known — nothing stored", display: `\x1b[2m✎ already known: ${r.memory.text}\x1b[0m` };
      const sup = r.superseded ? ` (replaced an older fact)` : "";
      return { output: `remembered (${r.memory.scope})${sup}`, display: `\x1b[2m✎ remembered: ${r.memory.text}${sup}\x1b[0m` };
    },
  });

  registerTool({
    name: "recall",
    description: "Fetch the full body of a reference-type memory by id (reference bodies are not auto-recalled — only their titles are).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    needsApproval: false,
    async run(args) {
      const id = String(args.id ?? "");
      for (const scope of includeProject ? (["project", "user"] as MemScope[]) : (["user"] as MemScope[])) {
        let body: string;
        try {
          body = readFileSync(refFile(scope, id), "utf8");
        } catch {
          continue; // try next scope
        }
        // Load-time secret gate applies to reference bodies too — a hand-edited/synced body can't
        // smuggle a secret into context via recall.
        if (!redactScan(body).ok) return { output: "refused: reference body matches a secret pattern", isError: true };
        return { output: body };
      }
      return { output: `no reference body for id ${id}`, isError: true };
    },
  });
}

// ---- /memory command (REPL) + `ada memory` (headless) ----
export async function memoryCommand(argv: string[], includeProject: boolean): Promise<void> {
  const [sub, ...rest] = argv;
  const arg = rest.join(" ").trim();
  const scopesOf = (): MemScope[] => (includeProject ? ["project", "user"] : ["user"]);

  const list = (): void => {
    const mems = loadMemories(includeProject);
    if (!mems.length) return console.log("no memories yet. ada remembers durable facts as you work, or add one: /memory add <fact>");
    for (const scope of scopesOf()) {
      const s = mems.filter((m) => m.scope === scope);
      if (!s.length) continue;
      console.log(`\x1b[1m${scope}\x1b[0m`);
      for (const m of s) console.log(`  ${m.pin ? "📌" : "·"} \x1b[2m${m.id}\x1b[0m ${m.text} \x1b[2m[${m.type}]\x1b[0m`);
    }
  };

  switch (sub) {
    case undefined:
    case "list":
      return list();
    case "add": {
      if (!arg) return console.log("usage: /memory add <fact>");
      const r: WriteResult = smartWrite ? await smartWrite({ text: arg }) : rememberFact({ text: arg });
      if (!r.ok) return console.log(`refused: ${r.reason}`);
      return console.log(r.skipped ? `already known: ${r.memory.text}` : `✎ remembered (${r.memory.scope})`);
    }
    case "forget": {
      if (!arg) return console.log("usage: /memory forget <id|substring>");
      const hit = findAcross(arg, includeProject);
      if (!hit) return console.log(`no memory matches "${arg}"`);
      mutate(hit.scope, (all) => all.filter((m) => m.id !== hit.m.id));
      return console.log(`forgot: ${hit.m.text}`);
    }
    case "edit": {
      const [id, ...t] = rest;
      const text = t.join(" ").trim();
      if (!id || !text) return console.log("usage: /memory edit <id> <new text>");
      const scan = redactScan(text);
      if (!scan.ok) return console.log(`refused: ${scan.reason}`);
      let done = false;
      for (const scope of scopesOf()) mutate(scope, (all) => all.map((m) => (m.id === id ? ((done = true), { ...m, text, used: today() }) : m)));
      return console.log(done ? "edited" : `no memory with id ${id}`);
    }
    case "pin":
    case "unpin": {
      if (!arg) return console.log(`usage: /memory ${sub} <id>`);
      let done = false;
      for (const scope of scopesOf()) mutate(scope, (all) => all.map((m) => (m.id === arg ? ((done = true), { ...m, pin: sub === "pin" }) : m)));
      return console.log(done ? `${sub}ned ${arg}` : `no memory with id ${arg}`);
    }
    case "search": {
      if (!arg) return console.log("usage: /memory search <query>");
      // Ungated on purpose — an explicit search should show near-misses; auto-recall is the gated one.
      const ranked = (await rankHybrid(arg, loadMemories(includeProject))).slice(0, 10);
      if (!ranked.length) return console.log("no matches");
      for (const r of ranked) {
        const how = r.lex && r.sem ? "both" : r.sem ? "semantic" : "lexical";
        console.log(`  \x1b[2m${(r.score * 1000).toFixed(1)}\x1b[0m ${r.m.text} \x1b[2m${r.m.id} · ${how}\x1b[0m`);
      }
      return;
    }
    case "why": {
      const inj = lastInjected();
      if (!inj.length) return console.log("no memories were injected on the last turn");
      const mems = loadMemories(includeProject);
      for (const { id, score } of inj) {
        const m = mems.find((x) => x.id === id);
        console.log(`  \x1b[2m${score}\x1b[0m ${m?.text ?? id}`);
      }
      return;
    }
    case "consolidate":
      return consolidate(includeProject);
    default:
      return console.log("usage: /memory [list|add|forget|edit|pin|unpin|search|why|consolidate]");
  }
}

/** Merge near-duplicates and decay/prune fossils. Deterministic (lexical); superseded lines stay in
 *  the file for git history. ponytail: a model-driven merge pass is a follow-up. */
function consolidate(includeProject: boolean): void {
  for (const scope of includeProject ? (["project", "user"] as MemScope[]) : (["user"] as MemScope[])) {
    const raw = readScopeRaw(scope);
    const live = raw.filter((m) => !m.superseded);
    const seen = new Map<string, Memory>();
    let merged = 0;
    for (const m of live) {
      const key = normalize(m.text);
      const prev = seen.get(key);
      if (prev) {
        prev.hits += m.hits + 1;
        m.superseded = prev.id;
        merged++;
      } else {
        seen.set(key, m);
      }
    }
    if (merged) writeScope(scope, raw);
    console.log(`${scope}: ${live.length - merged} facts${merged ? `, merged ${merged} duplicate(s)` : ""}`);
  }
}
