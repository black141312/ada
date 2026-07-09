// Auto-memory: durable facts ada recalls automatically at the start of every turn. Storage is plain
// Markdown bullets (git-diffable, hand-editable) under .ada/memory/ (project, trusted-gated) and
// ~/.ada/memory/ (global). Recall reuses the lexical ranker (skill-router.rankSkills) — deterministic,
// offline, zero-dep — and rides agent.ts's per-turn transient system-note seam, so it's recomputed
// fresh each turn and NEVER persisted: context stays flat as the store grows.
//
// Design guarantees (see selfcheck-memory.ts):
//   - cost-free-until-relevant: an off-topic turn injects zero facts (hard score floor);
//   - ranked-not-dumped + budget-capped (≤ K facts, ≤ char cap; drop whole facts, never truncate);
//   - ephemeral recall: a recall turn leaves the persistent message list unchanged;
//   - secret-safe: redactScan refuses secrets on EVERY write AND at load — a leaked value can't
//     enter context even via a hand-edit;
//   - supersede-not-duplicate: a same-subject value change retires the old fact (kept for git audit).
//
// ponytail: lexical recall is the always-on hot path (a per-turn embedding/LLM re-rank is a cut
// anti-feature). An optional Ollama-embedding blend for /memory search is the documented follow-up.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  used: string;
  hits: number;
  superseded?: string; // id that replaced this one — kept in the file for audit, excluded from recall
}

const K = Number(process.env.ADA_MEMORY_K) || 7; // max facts injected per turn
const CHAR_CAP = Number(process.env.ADA_MEMORY_CHARS) || 1800; // rough ~450-token ceiling on the block
const FLOOR = Number(process.env.ADA_MEMORY_FLOOR) || 1; // min rank score for a fact to be recalled
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
  /sk-[A-Za-z0-9]{16,}/, // OpenAI
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
 *  Returns the stored memory, or null if refused (secret) — the caller surfaces the reason. */
export function rememberFact(input: { text: string; scope?: MemScope; type?: MemType; tags?: string[]; body?: string }): { ok: true; memory: Memory; superseded?: string } | { ok: false; reason: string } {
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
  const m: Memory = { id: newId(), text, type, scope, pin: false, tags: input.tags ?? [], added: today(), used: today(), hits: 0 };
  // supersede: an existing live line about the SAME subject AND genuinely similar (a changed value),
  // not merely a shared leading bigram — so distinct safety facts are never silently retired.
  const same = raw.find((x) => !x.superseded && subj && subjectKey(x.text) === subj && normalize(x.text) !== norm && similar(x.text, text) >= 0.4);
  if (same) {
    same.superseded = m.id;
    supersededId = same.id;
  }
  if (input.type === "reference" && input.body) {
    mkdirSync(join(memDir(scope), "ref"), { recursive: true });
    writeFileSync(refFile(scope, m.id), input.body);
  }
  raw.push(m);
  writeScope(scope, raw);
  return { ok: true, memory: m, superseded: supersededId };
}

function inferScope(text: string): MemScope {
  const t = " " + text.toLowerCase() + " ";
  if (/\b(this repo|this project|here|we use|we deploy|our |in this codebase)\b/.test(t)) return "project";
  if (/\b(i always|i prefer|my name|i generally|i like|call me)\b/.test(t)) return "user";
  return "project"; // narrower by default when unsure
}

// ---- ranking / recall ----
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
    if (m) out.push({ m, score: r.score });
  }
  return out;
}

let _lastInjected: { id: string; score: number }[] = [];
export function lastInjected(): { id: string; score: number }[] {
  return _lastInjected;
}

/** The auto-recall block for a turn: pinned + small user-core facts always, then the highest-ranked
 *  relevant facts up to the budget. Null when nothing clears the floor (an off-topic turn = no cost). */
export function recallBlock(query: string, includeProject: boolean): string | null {
  const mems = loadMemories(includeProject);
  if (!mems.length) return null;
  const pinned = mems.filter((m) => m.pin);
  const core = mems.filter((m) => !m.pin && m.scope === "user" && m.type === "preference" && m.text.length < 120);
  const alwaysIds = new Set([...pinned, ...core].map((m) => m.id));
  const rest = mems.filter((m) => !alwaysIds.has(m.id));
  const ranked = rankMemories(query, rest).filter((r) => r.score >= FLOOR);

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
  _lastInjected = kept.map((c) => ({ id: c.m.id, score: c.score === Infinity ? 999 : Math.round(c.score * 100) / 100 }));
  const lines = kept.map((c) => {
    const tail = c.m.pin ? "  [pinned]" : c.m.type === "reference" ? `  (reference — call recall({id:"${c.m.id}"}) for details)` : "";
    return `- ${c.m.text}${tail}`;
  });
  return `Relevant memories (auto-recalled from earlier sessions; use if helpful, ignore if not):\n${lines.join("\n")}`;
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
      const r = rememberFact({
        text: String(args.text ?? ""),
        scope: args.scope === "user" || args.scope === "project" ? args.scope : undefined,
        type: args.type as MemType | undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        body: args.body ? String(args.body) : undefined,
      });
      if (!r.ok) return { output: `refused: ${r.reason}`, display: `\x1b[33m⚠ not remembered: ${r.reason}\x1b[0m`, isError: false };
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
export function memoryCommand(argv: string[], includeProject: boolean): void {
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
      const r = rememberFact({ text: arg });
      return console.log(r.ok ? `✎ remembered (${r.memory.scope})` : `refused: ${r.reason}`);
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
      const ranked = rankMemories(arg, loadMemories(includeProject)).slice(0, 10);
      if (!ranked.length) return console.log("no matches");
      for (const r of ranked) console.log(`  \x1b[2m${r.score.toFixed(1)}\x1b[0m ${r.m.text} \x1b[2m${r.m.id}\x1b[0m`);
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
