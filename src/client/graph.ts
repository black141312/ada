// A temporal knowledge graph, ada-native — the useful 90% of Graphiti with no Neo4j, no Python,
// no new npm install. It reuses what's already in the tree: better-sqlite3 (a dep) for an indexed,
// point-in-time store, and the rankSkills lexical ranker (what memory.ts already recalls with).
//
// An edge is a fact: subject —predicate→ object, true over a span of time. A contradicting fact
// INVALIDATES the old edge (sets valid_to) instead of deleting it — so "what did we believe on
// date X" stays answerable. That bi-temporal invalidate-don't-delete is the one idea a flat fact
// store (memory.ts) lacks; typed edges + multi-hop traversal are the other.
//
// wireGraphMemory() connects this to memory.ts so remembered facts extract into the graph
// automatically. Run the self-check:  npx tsx src/client/graph.ts
import type Database from "better-sqlite3";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sqliteOptions } from "../server/sqlite-binding.ts";
import { rankSkills } from "./skill-router.js";
import { setFactExtractor, setRecallAugmenter } from "./memory.js";
import { registerTool } from "./tools.js";

export type Edge = {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  fact: string; // natural-language statement, used for recall
  valid_from: number; // ms epoch — when the fact became true
  valid_to: number | null; // null = still true; set when superseded
  created_at: number; // ingestion time (the other temporal axis)
};

const asScript = !!process.argv[1]?.endsWith("graph.ts");

// better-sqlite3 is a native module the desktop bundle deliberately leaves out — the app's
// extraResources filter drops it and CI removes the dependency, exactly as it does for node-pty.
// So it is required on first use rather than imported: a static import would make merely STARTING
// the packaged CLI throw, because cli.ts imports this module at startup. Type-only import above,
// which TypeScript erases, so nothing reaches for the module until getDriver() does.
let dbMod: typeof Database | null | undefined;
function getDriver(): typeof Database | null {
  if (dbMod === undefined) {
    try {
      const mod = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
      // OPEN one, don't just require it. `require` loads the JS wrapper alone — the .node binding is
      // dlopen'd on first use. So a driver built for another ABI sails through the require and
      // throws much later: the desktop app runs the agent under Electron's Node (ABI 136) while a
      // dev `npm install` builds against system Node (137), and the result was `graphAvailable()`
      // answering true, memory hooks wiring themselves up, and a raw
      // "compiled against a different Node.js version" landing in the middle of a chat.
      new mod(":memory:").close();
      dbMod = mod;
    } catch {
      dbMod = null;
    }
  }
  return dbMod;
}

/** Whether the graph can run here. False in the packaged app, where the native driver is absent. */
export function graphAvailable(): boolean {
  return getDriver() !== null;
}

// Opened lazily, so merely importing this module (e.g. into the CLI) never creates a db file —
// the .ada/graph.db appears only when the first fact is actually stored.
let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const Driver = getDriver();
  if (!Driver) throw new Error("knowledge graph unavailable: better-sqlite3 is not installed here");
  const path = process.env.ADA_GRAPH_DB ?? (asScript ? ":memory:" : join(process.cwd(), ".ada", "graph.db"));
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // Same ABI story as auth.ts: the desktop app runs this under Electron's Node, not the system one.
  _db = new Driver(path, sqliteOptions());
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    create table if not exists edges (
      id integer primary key,
      subject text not null, predicate text not null, object text not null,
      fact text not null,
      valid_from integer not null, valid_to integer,
      created_at integer not null
    );
    create index if not exists edges_live on edges(subject, predicate) where valid_to is null;
    create index if not exists edges_subj on edges(subject);
    create index if not exists edges_obj  on edges(object);
  `);
  return _db;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Record a fact. Retires the live edge with the same (subject, predicate) whose object differs —
 *  i.e. single-valued relations (works_at, lives_in). Idempotent for an unchanged fact.
 *  ponytail: single-valued supersede. Multi-valued relations (knows, tagged_with) would over-retire —
 *  key the supersede on (subject,predicate,object), or LLM-judged contradiction like real Graphiti, if needed. */
export function addEdge(e: { subject: string; predicate: string; object: string; fact?: string; at?: number }): Edge {
  const at = e.at ?? Date.now();
  const subject = norm(e.subject), predicate = norm(e.predicate), object = norm(e.object);
  const fact = e.fact ?? `${e.subject} ${e.predicate} ${e.object}`;
  const live = db().prepare("select * from edges where subject=? and predicate=? and valid_to is null").get(subject, predicate) as Edge | undefined;
  if (live) {
    if (live.object === object) return live; // unchanged → no-op
    db().prepare("update edges set valid_to=? where id=?").run(at, live.id);
  }
  const info = db().prepare("insert into edges(subject,predicate,object,fact,valid_from,valid_to,created_at) values(?,?,?,?,?,null,?)").run(subject, predicate, object, fact, at, at);
  return db().prepare("select * from edges where id=?").get(info.lastInsertRowid) as Edge;
}

const liveAt = "valid_from<=@t and (valid_to is null or valid_to>@t)";

/** Edges touching `entity` (as subject or object), live at `asOf` (default: now). depth>1 walks the
 *  graph breadth-first, following object→subject links. */
export function neighbors(entity: string, opts: { asOf?: number; depth?: number } = {}): Edge[] {
  const t = opts.asOf ?? Date.now();
  const depth = opts.depth ?? 1;
  const stmt = db().prepare(`select * from edges where (subject=@e or object=@e) and ${liveAt}`);
  const seen = new Set<string>(), out: Edge[] = [], outIds = new Set<number>();
  let frontier = [norm(entity)];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const e of frontier) {
      if (seen.has(e)) continue;
      seen.add(e);
      for (const edge of stmt.all({ e, t }) as Edge[]) {
        if (!outIds.has(edge.id)) { outIds.add(edge.id); out.push(edge); }
        next.push(edge.subject === e ? edge.object : edge.subject);
      }
    }
    frontier = next;
  }
  return out;
}

/** Lexical recall over live facts (as of `asOf`). ponytail: token-overlap ranking, same as memory.ts —
 *  swap in cosine over stored embeddings (embed-index.ts) if/when this measurably under-recalls. */
export function search(query: string, k = 6, opts: { asOf?: number } = {}): Edge[] {
  const t = opts.asOf ?? Date.now();
  const rows = db().prepare(`select * from edges where ${liveAt}`).all({ t }) as Edge[];
  const items = rows.map((r) => ({ name: `${r.subject} ${r.predicate} ${r.object}`, description: r.fact }));
  const ranked = rankSkills(query, items, k);
  const byFact = new Map<string, Edge[]>();
  for (const r of rows) (byFact.get(r.fact) ?? byFact.set(r.fact, []).get(r.fact)!).push(r);
  return ranked.map((r) => byFact.get(r.description)?.shift()).filter((e): e is Edge => !!e);
}

// Predicate cues, "verbs? (prep)" so both tenses match. Longest phrases first via the regex order.
// ponytail: high-precision SVO heuristic — it returns null rather than emit a garbage triple, so a
// mediocre parse never pollutes the graph. Register an LLM extractor via setFactExtractor for the
// long tail (imperatives, compound clauses) if recall ever needs it.
const PRED = /^(.+?)\s+(deploys?\s+(?:from|via|to)|works?\s+at|lives?\s+in|reports?\s+to|belongs?\s+to|depends?\s+on|prefers?|requires?|needs?|uses?|likes?|owns?|is|are|was|were|has|have)\s+(.+)$/i;

/** Best-effort (subject, predicate, object) from a one-sentence fact; null when it can't parse cleanly. */
export function extractEdge(fact: string): { subject: string; predicate: string; object: string } | null {
  const m = fact.trim().replace(/[.\s]+$/, "").match(PRED);
  if (!m) return null;
  const subject = m[1]!.trim(), predicate = m[2]!.trim().replace(/\s+/g, " ").toLowerCase(), object = m[3]!.trim();
  if (!subject || !object || subject.length > 60) return null; // guard: no empty ends, no runaway subject
  return { subject, predicate, object };
}

/** Related facts for a query — the read side. Lexical matches seed the entities the query names;
 *  their 1-hop neighbours bring in the *relationships* (the connected facts a flat store would miss).
 *  Returns the natural-language `fact` of each, deduped, newest-relevant first, capped at `limit`. */
export function recallEdges(query: string, limit = 6, opts: { asOf?: number } = {}): string[] {
  const seeds = search(query, 4, opts);
  if (!seeds.length) return [];
  const byId = new Map<number, Edge>();
  for (const e of seeds) byId.set(e.id, e); // the direct matches first
  const entities = new Set(seeds.flatMap((e) => [e.subject, e.object]));
  for (const ent of entities) for (const e of neighbors(ent, { depth: 1, asOf: opts.asOf })) byId.set(e.id, e);
  return [...byId.values()].slice(0, limit).map((e) => e.fact);
}

/** Answer an on-demand graph question as plain text lines. Pure (no I/O beyond the db) so it's
 *  testable without the tool registry. `entity` → its connections (depth hops); else `query` → search. */
export function queryGraph(opts: { entity?: string; query?: string; depth?: number }): string {
  const entity = opts.entity?.trim() ?? "", query = opts.query?.trim() ?? "";
  if (!entity && !query) return "give an `entity` to expand or a `query` to search";
  const depth = Math.max(1, Math.min(3, opts.depth || 1));
  const facts = entity ? [...new Set(neighbors(entity, { depth }).map((e) => e.fact))] : recallEdges(query, 10);
  if (!facts.length) return entity ? `no facts about "${entity}"` : `no facts match "${query}"`;
  return facts.slice(0, 20).map((f) => `- ${f}`).join("\n");
}

/** Register the read-only graph_query tool so the model can ask the graph directly. */
export function registerGraphTools(): void {
  registerTool({
    name: "graph_query",
    description:
      "Query the knowledge graph of facts remembered across sessions — the relationships between people, projects, tools, and places. Give `entity` to list what it connects to, or `query` to search facts by text. Read-only.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", description: "an entity to list connections for (a person, project, tool, or place)" },
        query: { type: "string", description: "free-text search over facts, when you don't have an exact entity name" },
        depth: { type: "number", description: "hops to expand from `entity` (default 1; 2 = connections-of-connections)" },
      },
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const out = queryGraph({
        entity: typeof args.entity === "string" ? args.entity : undefined,
        query: typeof args.query === "string" ? args.query : undefined,
        depth: typeof args.depth === "number" ? args.depth : undefined,
      });
      return { output: out };
    },
  });
}

/** Connect the graph to the rest of the system:
 *   write — every remembered fact is auto-extracted into an edge;
 *   read  — recall surfaces related facts (a query's entities and their neighbours) back into context;
 *   tool  — graph_query lets the model ask the graph on demand.
 *  Call once at startup. No-op-safe — a hook throw never breaks remembering or recall.
 *  Returns without wiring anything where the native driver is missing (the packaged desktop app),
 *  so no hook and no tool exists that could fail: the feature is simply off, not broken. */
export function wireGraphMemory(): void {
  if (!graphAvailable()) return;
  setFactExtractor((fact) => {
    const e = extractEdge(fact);
    if (e) addEdge({ ...e, fact });
  });
  setRecallAugmenter((query, includeProject) => {
    if (!includeProject) return null; // graph.db is project-local — honour the same trust gate as project memory
    const facts = recallEdges(query);
    return facts.length ? `Related facts (knowledge graph):\n${facts.map((f) => `- ${f}`).join("\n")}` : null;
  });
  registerGraphTools();
}

// --- self-check (ponytail: the temporal supersede + point-in-time query + extraction is the logic) ---
if (asScript) {
  const t0 = 1_000, t1 = 2_000, t2 = 3_000;

  // The driver is optional: present here (dev/CLI), absent in the packaged app. Everything below
  // needs it, so fail loudly if it vanished from a dev tree rather than silently skipping the suite.
  assert.equal(graphAvailable(), true, "better-sqlite3 should be installed in a dev tree");

  // "Available" must mean USABLE, not merely requireable. A `require` loads the JS wrapper while the
  // native binding is dlopen'd on first use, so a driver built for another ABI passed the old check
  // and then threw mid-agent-turn. Asserting the flag AGREES with a real open is what catches that:
  // run under a mismatched runtime (the app's Electron Node vs a system-Node build), the two answers
  // diverge and this fails, instead of a raw dlopen error surfacing in someone's chat.
  let reallyOpens: boolean;
  try {
    const D = createRequire(import.meta.url)("better-sqlite3") as typeof Database;
    new D(":memory:").close();
    reallyOpens = true;
  } catch {
    reallyOpens = false;
  }
  assert.equal(graphAvailable(), reallyOpens, "graphAvailable() must reflect whether the driver actually opens, not just whether it resolves");

  addEdge({ subject: "Alice", predicate: "works_at", object: "Acme", at: t0 });
  addEdge({ subject: "Acme", predicate: "located_in", object: "Berlin", at: t0 });
  assert.equal(neighbors("Alice", { asOf: t1 }).length, 1, "one live edge at t1");

  // supersede: Alice changes jobs at t2 — old fact invalidated, not deleted
  addEdge({ subject: "Alice", predicate: "works_at", object: "Globex", at: t2 });
  assert.equal(neighbors("Alice", { asOf: t2 })[0]!.object, "globex", "current view = newest fact");
  assert.equal(neighbors("Alice", { asOf: t1 })[0]!.object, "acme", "point-in-time query still sees the old fact");

  // idempotent re-assert adds nothing
  const before = search("acme globex", 99, { asOf: t2 }).length;
  addEdge({ subject: "Alice", predicate: "works_at", object: "Globex", at: t2 + 1 });
  assert.equal(search("acme globex", 99, { asOf: t2 + 5 }).length, before, "re-asserting an unchanged fact is a no-op");

  // multi-hop: Alice → Acme → Berlin, live at t1
  const hops = neighbors("Alice", { asOf: t1, depth: 2 }).map((e) => e.object);
  assert.ok(hops.includes("berlin"), "depth=2 reaches Berlin via Acme");

  // lexical recall finds the relevant fact
  assert.equal(search("where is acme", 1)[0]!.object, "berlin", "search surfaces the located_in fact");

  // extraction: clean facts parse, junk returns null (never a garbage triple)
  assert.deepEqual(extractEdge("test runner is vitest"), { subject: "test runner", predicate: "is", object: "vitest" }, "copula parses");
  assert.deepEqual(extractEdge("We deploy from the release branch"), { subject: "We", predicate: "deploy from", object: "the release branch" }, "verb+prep parses");
  assert.equal(extractEdge("never delete the prod database"), null, "imperative → null, not a bogus edge");
  assert.equal(extractEdge("uses pnpm for the web app"), null, "no subject → null");

  // end-to-end: the extractor lands an edge
  extractEdge("Bob works at Globex") && addEdge({ ...extractEdge("Bob works at Globex")!, fact: "Bob works at Globex", at: t2 });
  assert.equal(neighbors("bob", { asOf: t2 })[0]!.object, "globex", "extracted fact is queryable");

  // recall (read side): a query's matches pull in their neighbours — Alice's current job AND its co-worker
  const related = recallEdges("alice", 6, { asOf: t2 + 10 });
  assert.ok(related.some((f) => /globex/i.test(f)), "recallEdges surfaces the matching fact");
  assert.ok(related.some((f) => /bob/i.test(f)), "recallEdges pulls in a neighbour (Bob, via the shared Globex node)");

  // graph_query (on demand): entity lists connections; query searches; guards return guidance
  assert.match(queryGraph({ entity: "globex", depth: 1 }), /alice|bob/i, "queryGraph(entity) lists connections");
  assert.match(queryGraph({ query: "acme" }), /berlin/i, "queryGraph(query) searches facts");
  assert.match(queryGraph({}), /entity.*query/i, "queryGraph with nothing → guidance");
  assert.match(queryGraph({ entity: "nobody-here" }), /no facts/i, "unknown entity → no facts");

  console.log("graph.ts selfcheck OK");
}
