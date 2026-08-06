#!/usr/bin/env node
// Auto-memory EXTRACTION eval — the other half of bench/memory.ts.
//
// bench/memory.ts asks "given a fact is stored, does it come back?". This asks the prior question:
// "reading a real session, does ada write down the right things and only the right things?" Recall
// tuning is worthless if the ledger fills with transient noise, and a ledger that learns nothing is
// worse still.
//
//   npx tsx bench/extraction.ts              # one pass over every transcript
//   npx tsx bench/extraction.ts --runs 3     # repeat and average — extraction is SAMPLED, see below
//   npx tsx bench/extraction.ts --verbose    # print every extracted fact and its best match
//   npx tsx bench/extraction.ts --selftest   # offline checks of the pure scoring helpers
//
// Needs a running ada-server (node bin/ada-server.mjs) — unlike the recall bench, this one is all
// model calls. Roughly 25 cheap calls per run.
//
// Scoring. Extraction paraphrases, so ground truth cannot be string-matched: "the test runner is
// vitest, not jest" and "the project uses vitest for tests" are the same fact. Expected and actual
// are matched by embedding cosine (the same local encoder recall uses) above MATCH. Every pairing is
// printable with --verbose so the threshold stays auditable rather than a magic number.
//
// This measures the END of the pipeline — what actually lands in the ledger — so the secret gate,
// the dedup pass and the LLM judge are all in scope, not just the extraction prompt.
//
// ponytail: 6 hand-written transcripts, scored in-process. No dataset, no annotation tool, no judge
// model — "did this land in the ledger" is decidable, and the fixtures are the specification.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";

type Turn = { role: "user" | "assistant"; content: string };

interface Fixture {
  name: string;
  what: string; // what this case is testing
  turns: Turn[];
  /** Facts that SHOULD end up in the ledger. Wording is indicative — matching is by meaning. */
  expect: string[];
  /** Substrings that must never appear in any stored fact (secrets, transient state). */
  forbid?: string[];
}

// --- fixtures -----------------------------------------------------------------------------------

const FIXTURES: Fixture[] = [
  {
    name: "rules-vs-oneoffs",
    what: "standing rules are durable; task requests in the same breath are not",
    turns: [
      { role: "user", content: "before we start — always run the linter before you commit, we've had three broken builds this month from skipping it" },
      { role: "assistant", content: "Understood, I'll lint before committing." },
      { role: "user", content: "ok now can you rename the handler in src/api/users.ts to fetchUser? just this one file" },
      { role: "assistant", content: "Renamed it." },
      { role: "user", content: "thanks. also we never merge to main directly, everything goes through a PR" },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "cool, now bump the version in package.json to 2.1.0" },
    ],
    expect: ["The linter must be run before committing", "All changes go through a pull request; never merge directly to main"],
    forbid: ["2.1.0", "fetchUser"],
  },
  {
    name: "nothing-durable",
    what: "a session of pure task work must produce ZERO facts — silence is a correct answer",
    turns: [
      { role: "user", content: "the test on line 40 of parser.test.ts is failing, can you look" },
      { role: "assistant", content: "The assertion expects an array but the parser returns undefined for empty input." },
      { role: "user", content: "ah right, fix it so it returns an empty array" },
      { role: "assistant", content: "Done, the test passes now." },
      { role: "user", content: "great, can you also run the full suite" },
      { role: "assistant", content: "All 214 tests pass." },
      { role: "user", content: "perfect, ship it" },
    ],
    expect: [],
  },
  {
    name: "secret-in-transcript",
    what: "a credential mentioned in passing must never reach the ledger",
    turns: [
      { role: "user", content: "our deploy target is always the eu-west-1 region, that's a compliance requirement" },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "here's the deploy key if you need it: AKIAIOSFODNN7EXAMPLE and the secret is wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" },
      { role: "assistant", content: "I won't store those." },
    ],
    expect: ["Deployments must target the eu-west-1 region for compliance"],
    forbid: ["AKIA", "wJalrXUtnFEMI"],
  },
  {
    name: "correction",
    what: "when the user corrects themselves, the LATER statement is what should survive",
    turns: [
      { role: "user", content: "we use yarn for everything in this repo" },
      { role: "assistant", content: "Got it, yarn." },
      { role: "user", content: "actually scratch that — we moved to pnpm last month, I keep forgetting. pnpm workspaces, and yarn is gone entirely" },
      { role: "assistant", content: "Understood, pnpm workspaces." },
    ],
    expect: ["The repo uses pnpm workspaces"],
    forbid: ["yarn for everything"],
  },
  {
    name: "tool-output-heavy",
    what: "file listings and command output are not facts, however much of the transcript they fill",
    turns: [
      { role: "user", content: "what's in the src directory" },
      { role: "assistant", content: "src/ contains: index.ts, server.ts, router.ts, db.ts, auth.ts, utils/, models/, and 14 test files under __tests__/." },
      { role: "user", content: "and how big is db.ts" },
      { role: "assistant", content: "db.ts is 412 lines, mostly query builders." },
      { role: "user", content: "ok. one thing worth knowing — db.ts is generated, never edit it by hand, regenerate with npm run db:gen" },
      { role: "assistant", content: "Understood." },
    ],
    expect: ["db.ts is generated and must not be edited by hand; regenerate it with npm run db:gen"],
    forbid: ["412 lines", "14 test files"],
  },
  {
    name: "task-scoped-rule",
    what: "a rule that SOUNDS standing but is scoped to one task must not become permanent",
    turns: [
      { role: "user", content: "for this refactor, keep the old API around so nothing breaks mid-migration — we'll delete it once the last caller is moved" },
      { role: "assistant", content: "Keeping the old API for now." },
      { role: "user", content: "and while we're in here, don't touch the billing module at all today, someone else has it open" },
      { role: "assistant", content: "Understood." },
    ],
    expect: [],
    forbid: ["billing module"],
  },
  {
    name: "inferred-not-stated",
    what: "what the user implies but never says is not a fact — extraction must not infer",
    turns: [
      { role: "user", content: "why is this failing on windows again" },
      { role: "assistant", content: "The path is built with a forward slash literal, which breaks on Windows." },
      { role: "user", content: "of course it is. fix it with path.join" },
      { role: "assistant", content: "Fixed." },
      { role: "user", content: "third time this week" },
    ],
    expect: [],
  },
  {
    name: "dense-session",
    what: "five durable facts in one slice — exposes the per-pass cap as a recall ceiling",
    turns: [
      { role: "user", content: "quick context dump before you start. We're on Postgres 16. All timestamps are stored in UTC, always." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "The API is versioned under /v2 and we don't break v1, ever. Tests must run offline — no network calls in the suite." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "And every table needs a soft-delete column, we never hard delete rows." },
      { role: "assistant", content: "Got it." },
    ],
    expect: [
      "The database is Postgres 16",
      "All timestamps are stored in UTC",
      "The API is versioned under /v2 and v1 must never be broken",
      "Tests must run offline with no network calls",
      "Every table needs a soft-delete column; rows are never hard deleted",
    ],
  },
  {
    name: "user-preference",
    what: "personal working preferences are durable and belong to the user, not the repo",
    turns: [
      { role: "user", content: "one thing about how I work — I don't want explanations unless I ask. Just show me the diff." },
      { role: "assistant", content: "Understood." },
      { role: "user", content: "and I read code faster than prose, so prefer showing me code over describing it" },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "now let's look at the auth bug" },
    ],
    expect: ["Show the diff without explanation unless explanations are asked for", "Prefer showing code over describing it in prose"],
  },
];

/** Cosine above which an extracted fact counts as "the same fact" as an expected one. Statement-to-
 *  statement comparison is where bge is strongest, so this can sit high; --verbose prints the actual
 *  numbers so a wrong call is visible rather than hidden behind the constant. */
const MATCH = Number(process.env.ADA_EXTRACT_MATCH) || 0.75;

// --- scoring ------------------------------------------------------------------------------------

export interface Tally {
  expected: number;
  found: number; // expected facts matched by something stored
  stored: number; // facts actually written to the ledger
  junk: number; // stored facts matching no expected fact
  leaks: number; // stored facts containing a forbidden substring
}

export function f1(t: Tally): { recall: number; precision: number; f1: number } {
  const recall = t.expected ? t.found / t.expected : 1;
  // A fixture that expects nothing and stores nothing is perfectly precise, not undefined.
  const precision = t.stored ? (t.stored - t.junk) / t.stored : 1;
  const f = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return { recall, precision, f1: f };
}

const pctf = (x: number): string => `${(x * 100).toFixed(0)}%`;

// --- runner -------------------------------------------------------------------------------------

const dotp = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

async function runFixture(f: Fixture, client: OpenAI, model: string, dir: string, verbose: boolean): Promise<Tally> {
  process.env.ADA_MEMORY_DIR = dir;
  rmSync(dir, { recursive: true, force: true });
  const mem = await import("../src/client/memory.ts");
  const llm = await import("../src/client/memory-llm.ts");
  const vec = await import("../src/client/memory-vec.ts");
  vec.resetVectorCache();

  await llm.learnFromTranscript(client, model, f.turns as OpenAI.Chat.Completions.ChatCompletionMessageParam[], true);
  const stored = mem.loadMemories(true);
  const t: Tally = { expected: f.expect.length, found: 0, stored: stored.length, junk: 0, leaks: 0 };

  for (const m of stored) if (f.forbid?.some((bad) => m.text.includes(bad))) t.leaks++;

  if (stored.length && f.expect.length) {
    const { embedLocal, MEMORY_MODEL } = await import("../src/client/embed-local.ts");
    const E = await embedLocal(f.expect, MEMORY_MODEL);
    const S = await embedLocal(stored.map((m) => m.text), MEMORY_MODEL);
    const best = (v: number[], pool: number[][]): number => Math.max(...pool.map((p) => dotp(v, p)));
    t.found = E.filter((e) => best(e, S) >= MATCH).length;
    t.junk = S.filter((s) => best(s, E) < MATCH).length;
    if (verbose) {
      for (let i = 0; i < stored.length; i++) console.log(`      ${best(S[i]!, E) >= MATCH ? "ok  " : "junk"} ${best(S[i]!, E).toFixed(2)}  ${stored[i]!.text}`);
    }
  } else {
    t.junk = stored.length; // nothing was expected, so everything stored is junk
    if (verbose) for (const m of stored) console.log(`      junk ----  ${m.text}`);
  }
  return t;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");
  const runsFlag = argv.indexOf("--runs");
  const runs = runsFlag >= 0 ? Math.max(1, Number(argv[runsFlag + 1]) || 1) : 1;

  if (argv.includes("--selftest")) {
    assert.deepEqual(f1({ expected: 2, found: 2, stored: 2, junk: 0, leaks: 0 }), { recall: 1, precision: 1, f1: 1 });
    assert.equal(f1({ expected: 0, found: 0, stored: 0, junk: 0, leaks: 0 }).precision, 1, "expecting nothing and storing nothing is perfect, not a divide-by-zero");
    assert.equal(f1({ expected: 0, found: 0, stored: 3, junk: 3, leaks: 0 }).precision, 0, "storing junk when nothing was expected is zero precision");
    assert.equal(f1({ expected: 2, found: 1, stored: 1, junk: 0, leaks: 0 }).recall, 0.5);
    assert.equal(new Set(FIXTURES.map((f) => f.name)).size, FIXTURES.length, "fixture names are distinct");
    assert.ok(FIXTURES.some((f) => f.expect.length === 0), "at least one fixture must expect NOTHING — that is the case a lazy extractor passes by accident and an eager one fails");
    assert.ok(FIXTURES.some((f) => f.forbid?.length), "at least one fixture must guard against a leak");
    console.log("bench/extraction selftest OK");
    return;
  }

  const { default: OpenAI } = await import("openai");
  const base = process.env.ADA_BACKEND_URL ?? "http://localhost:8787/v1";
  const client = new OpenAI({ baseURL: base, apiKey: process.env.ADA_CLIENT_KEY ?? "dev", maxRetries: 1 });
  const model = process.env.ADA_EXTRACT_MODEL ?? "deepseek/deepseek-v4-flash-0731";
  try {
    await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
  } catch {
    console.error(`no ada-server at ${base} — start one with: node bin/ada-server.mjs`);
    process.exit(1);
  }

  const dir = join(tmpdir(), `ada-bench-ext-${Date.now()}`);
  console.log(`model: ${model} · ${FIXTURES.length} transcripts · ${runs} run(s) · match cosine >= ${MATCH}\n`);
  console.log("case                  recall  prec    stored  junk  leaks  what");
  console.log("--------------------  ------  ------  ------  ----  -----  ----");
  const totals: Tally = { expected: 0, found: 0, stored: 0, junk: 0, leaks: 0 };
  try {
    for (const f of FIXTURES) {
      const acc: Tally = { expected: 0, found: 0, stored: 0, junk: 0, leaks: 0 };
      for (let r = 0; r < runs; r++) {
        if (verbose) console.log(`  [${f.name} run ${r + 1}]`);
        const t = await runFixture(f, client, model, dir, verbose);
        for (const k of Object.keys(acc) as Array<keyof Tally>) acc[k] += t[k];
      }
      const s = f1(acc);
      console.log(
        `${f.name.padEnd(20)}  ${pctf(s.recall).padStart(6)}  ${pctf(s.precision).padStart(6)}  ${(acc.stored / runs).toFixed(1).padStart(6)}  ${String(acc.junk).padStart(4)}  ${String(acc.leaks).padStart(5)}  ${f.what}`,
      );
      for (const k of Object.keys(totals) as Array<keyof Tally>) totals[k] += acc[k];
    }
    const s = f1(totals);
    console.log(`\noverall  recall ${pctf(s.recall)}  precision ${pctf(s.precision)}  F1 ${pctf(s.f1)}  ·  ${(totals.stored / runs).toFixed(1)} facts stored per run, ${totals.junk} junk, ${totals.leaks} leaks`);
    if (totals.leaks) console.log("\n!! A FORBIDDEN STRING REACHED THE LEDGER — that is a secret-gate failure, not a quality one.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ADA_MEMORY_DIR;
  }
}

main().catch((e) => {
  console.error("bench/extraction FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
