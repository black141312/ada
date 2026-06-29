#!/usr/bin/env node
// SWE-bench (Verified) prediction generator, driven by ada.
//
// This produces an **official-format** predictions.jsonl. It does NOT score — scoring is done by the
// official `swebench` harness in Docker (the only way to get correct, comparable numbers). See
// bench/README.md for the full flow (dataset, prereqs, the scoring command).
//
// For each instance: clone the task repo at its base commit into an isolated dir, hand ada the issue
// text (headless `ada -p --json`, auto-approve), then capture `git diff` as the model patch.
//
//   node bench/swebench.mjs --dataset swe-bench-verified.jsonl --model claude-opus-4-8 \
//        --out runs/opus [--limit 5] [--instances id1,id2] [--concurrency 2] [--timeout 1200]
//   node bench/swebench.mjs --selftest      # offline checks of the pure helpers
//
// Prereqs: a running `ada-server` with provider keys, `git`, network (clones the task repos).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADA_BIN = resolve(HERE, "..", "bin", "ada.mjs");
const CACHE = process.env.ADA_SWEBENCH_CACHE || join(homedir(), ".cache", "ada-swebench");

// ---------- pure helpers (covered by --selftest) ----------

export function parseArgs(argv) {
  const f = { concurrency: 2, timeout: 1200, out: "runs/ada" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") f.selftest = true;
    else if (a === "--dataset") f.dataset = argv[++i];
    else if (a === "--model") f.model = argv[++i];
    else if (a === "--out") f.out = argv[++i];
    else if (a === "--limit") f.limit = Number(argv[++i]);
    else if (a === "--instances") f.instances = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") f.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--timeout") f.timeout = Number(argv[++i]);
    else if (a === "--ada") f.ada = argv[++i];
  }
  return f;
}

export function buildPrompt(repo, problemStatement) {
  return `The repository \`${repo}\` is checked out in the current directory at the commit where this issue was filed. Resolve the issue by editing the source code.

ISSUE:
${problemStatement}

Guidelines:
- Make the smallest change that fixes the issue.
- Edit only library/source files. Do NOT add or modify tests — the grader supplies its own.
- When the fix is complete and self-consistent, stop.`;
}

export function predictionLine(instanceId, model, patch) {
  return JSON.stringify({ instance_id: instanceId, model_name_or_path: model, model_patch: patch });
}

function loadJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function doneIds(predPath) {
  if (!existsSync(predPath)) return new Set();
  const ids = new Set();
  for (const row of loadJsonl(predPath)) if (row.instance_id) ids.add(row.instance_id);
  return ids;
}

export function selectInstances(all, { instances, limit }) {
  let xs = all;
  if (instances?.length) {
    const want = new Set(instances);
    xs = xs.filter((x) => want.has(x.instance_id));
  }
  if (limit && limit > 0) xs = xs.slice(0, limit);
  return xs;
}

// ---------- git + ada (impure) ----------

const cloneLocks = new Map(); // repo → in-flight clone promise (don't clone the same repo twice)
function git(args, opts = {}) {
  return spawnSync("git", args, { encoding: "utf8", ...opts });
}

async function ensureCache(repo) {
  const bare = join(CACHE, `${repo.replace("/", "__")}.git`);
  if (existsSync(bare)) return bare;
  if (!cloneLocks.has(repo)) {
    mkdirSync(CACHE, { recursive: true });
    cloneLocks.set(
      repo,
      new Promise((res, rej) => {
        const p = spawn("git", ["clone", "--bare", `https://github.com/${repo}.git`, bare], { stdio: "inherit" });
        p.on("exit", (code) => (code === 0 ? res(bare) : rej(new Error(`clone ${repo} failed (${code})`))));
        p.on("error", rej);
      }),
    );
  }
  return cloneLocks.get(repo);
}

async function prepInstance(repo, baseCommit, dir) {
  const bare = await ensureCache(repo);
  rmSync(dir, { recursive: true, force: true });
  // --shared: instance dirs reuse the cache's objects (cheap, isolated working trees). Safe because
  // we delete each dir before the cache is ever pruned.
  let r = git(["clone", "--shared", "--no-checkout", bare, dir]);
  if (r.status !== 0) throw new Error(`clone --shared failed: ${r.stderr}`);
  r = git(["-C", dir, "checkout", "--detach", baseCommit]);
  if (r.status !== 0) throw new Error(`checkout ${baseCommit.slice(0, 8)} failed: ${r.stderr}`);
}

function diffPatch(dir) {
  git(["-C", dir, "add", "-A"]);
  const r = git(["-C", dir, "diff", "--cached", "--no-color"]);
  return r.stdout ?? "";
}

function runAda(adaBin, prompt, cwd, model, timeoutMs) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [adaBin, "-p", prompt, "--model", model, "--json"], { cwd, env: process.env });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      let usage = "";
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      try {
        usage = line ? JSON.parse(line).usage ?? "" : "";
      } catch {
        /* ignore */
      }
      res({ code, timedOut, usage, err: err.slice(-500) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: -1, timedOut, usage: "", err: String(e) });
    });
  });
}

// ---------- run ----------

async function pool(items, n, worker) {
  const q = [...items.entries()];
  const runners = Array.from({ length: Math.min(n, q.length) }, async () => {
    for (;;) {
      const next = q.shift();
      if (!next) return;
      await worker(next[1], next[0]);
    }
  });
  await Promise.all(runners);
}

async function main(f) {
  if (!f.dataset || !f.model) {
    console.error("usage: node bench/swebench.mjs --dataset <verified.jsonl> --model <id> [--out dir] [--limit N] [--instances a,b] [--concurrency 2] [--timeout 1200]");
    process.exit(2);
  }
  const adaBin = f.ada || ADA_BIN;
  const outDir = resolve(f.out);
  mkdirSync(outDir, { recursive: true });
  const predPath = join(outDir, "predictions.jsonl");
  const metaPath = join(outDir, "meta.jsonl");

  const already = doneIds(predPath);
  const todo = selectInstances(loadJsonl(f.dataset), f).filter((x) => !already.has(x.instance_id));
  console.error(`ada SWE-bench · model=${f.model} · ${todo.length} instances (${already.size} already done) · concurrency=${f.concurrency} → ${outDir}`);

  let done = 0;
  let nonEmpty = 0;
  await pool(todo, f.concurrency, async (inst) => {
    const dir = join(CACHE, "wt", inst.instance_id);
    const t0 = Date.now();
    let patch = "";
    let note = "";
    try {
      await prepInstance(inst.repo, inst.base_commit, dir);
      const r = await runAda(adaBin, buildPrompt(inst.repo, inst.problem_statement), dir, f.model, f.timeout * 1000);
      patch = diffPatch(dir);
      note = r.timedOut ? "timeout" : r.code === 0 ? `usage:${r.usage}` : `exit ${r.code}: ${r.err}`;
    } catch (e) {
      note = `error: ${e instanceof Error ? e.message : e}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    appendFileSync(predPath, `${predictionLine(inst.instance_id, f.model, patch)}\n`);
    appendFileSync(metaPath, `${JSON.stringify({ instance_id: inst.instance_id, seconds: Math.round((Date.now() - t0) / 1000), patch_bytes: patch.length, note })}\n`);
    done++;
    if (patch.trim()) nonEmpty++;
    console.error(`  [${done}/${todo.length}] ${inst.instance_id} · ${patch.length}B patch · ${note.slice(0, 60)}`);
  });

  console.error(`\nwrote ${predPath}\n${done} run, ${nonEmpty} produced a non-empty patch. Score with the official harness — see bench/README.md.`);
}

// ---------- selftest ----------

function runSelftest() {
  const a = parseArgs(["--dataset", "d.jsonl", "--model", "m", "--limit", "3", "--instances", "x,y", "--concurrency", "4"]);
  assert.equal(a.dataset, "d.jsonl");
  assert.equal(a.model, "m");
  assert.equal(a.limit, 3);
  assert.deepEqual(a.instances, ["x", "y"]);
  assert.equal(a.concurrency, 4);

  const p = buildPrompt("django/django", "Boom on empty queryset.");
  assert.ok(p.includes("django/django") && p.includes("Boom on empty queryset.") && /do not add or modify tests/i.test(p), "prompt includes repo, issue, no-tests rule");

  const line = predictionLine("django__django-123", "claude-opus-4-8", "diff --git a b");
  const obj = JSON.parse(line);
  assert.deepEqual(Object.keys(obj).sort(), ["instance_id", "model_name_or_path", "model_patch"]);
  assert.equal(obj.instance_id, "django__django-123");

  const all = [{ instance_id: "a" }, { instance_id: "b" }, { instance_id: "c" }];
  assert.deepEqual(selectInstances(all, { instances: ["b", "c"], limit: 1 }).map((x) => x.instance_id), ["b"]);
  assert.deepEqual(selectInstances(all, { limit: 2 }).map((x) => x.instance_id), ["a", "b"]);

  console.log("swebench selftest OK");
}

const flags = parseArgs(process.argv.slice(2));
if (flags.selftest) runSelftest();
else await main(flags);
