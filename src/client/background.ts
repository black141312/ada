// Fire-and-forget background jobs: kick off a long, independent subtask without blocking the main
// loop; read results later with /jobs in the terminal, or the app's Background jobs section.
// Persisted to .ada/jobs.json so a result outlives the `ada serve` that produced it — the app had
// no way to reach one at all before, and a restart used to throw away every finished job.
//
// Also home to the two delegation tools, since both spawn a sub-agent: `spawn_agent` (wait for the
// answer) and `background_task` (don't). They live here rather than in the CLI's interactive branch
// so `ada serve` — the editor — registers them too.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type OpenAI from "openai";
import { Agent, type OnApprove, subagentModel } from "./agent.ts";
import { Session } from "./session.ts";
import { ensureAdaDir } from "./settings.ts";
import { registerTool } from "./tools.ts";

export interface Job {
  id: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled";
  result?: string;
  started: number;
  ended?: number;
  /** The serve session whose chat started this job. Absent for a job started from a terminal, which
   *  belongs to no chat and is only ever listed in the app's unscoped view. */
  sessionId?: string;
}

/** The target size `prune()` trims finished jobs down to on save — a job log is a convenience, not
 *  an audit trail. Not a hard ceiling: a running job is never dropped to make room, so the file can
 *  hold more than this while long jobs are in flight. */
const CAP = 50;

const storePath = (): string => resolve(process.cwd(), ".ada", "jobs.json");

/**
 * Rebuild the job list from whatever was on disk.
 *
 * Pure on purpose: every rule that matters when loading lives here, and none of them needs a
 * filesystem to test. The disk read below is then a wrapper with nothing to get wrong.
 *
 * Two of these rules are not optional. A job still marked `running` belonged to a process that no
 * longer exists, so it can never transition — loading it as-is shows a job running forever. And the
 * id counter has to continue from what was loaded, or the next `startJob` reuses `j1` and
 * overwrites the persisted `j1`, destroying exactly the result persistence was added to keep.
 *
 * `markRunningInterrupted` defaults on, for `load()`: this process has no jobs of its own yet, so a
 * `running` entry in the file can only be left over from a previous, now-dead invocation. `save()`'s
 * merge passes `false` for the same read against the *same* invariant, not despite it — mid-process,
 * a `running` entry it did not create belongs to another `ada` sharing this folder right now, and it
 * is very much alive. Rewriting that to "interrupted" would be lying about a job that is still going.
 */
export function reviveJobs(raw: unknown, markRunningInterrupted = true): { jobs: Job[]; nextSeq: number } {
  if (!Array.isArray(raw)) return { jobs: [], nextSeq: 0 };
  const jobs: Job[] = [];
  let nextSeq = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const j = r as Partial<Job>;
    if (typeof j.id !== "string" || typeof j.task !== "string" || typeof j.started !== "number") continue;
    const n = Number(j.id.replace(/^j/, ""));
    if (Number.isFinite(n) && n > nextSeq) nextSeq = n;
    if (j.status === "running" && markRunningInterrupted) {
      jobs.push({ id: j.id, task: j.task, status: "error", result: "interrupted — ada serve restarted", started: j.started, ended: Date.now(), sessionId: j.sessionId });
    } else {
      const status: Job["status"] =
        j.status === "running" ? "running" : j.status === "error" ? "error" : j.status === "cancelled" ? "cancelled" : "done";
      jobs.push({ id: j.id, task: j.task, status, result: j.result, started: j.started, ended: j.ended, sessionId: j.sessionId });
    }
  }
  return { jobs, nextSeq };
}

const jobs = new Map<string, Job>();
let seq = 0;
let loaded = false;

/** Abort handles for jobs still running, keyed by job id.
 *
 * Deliberately NOT a field on `Job`: that record is serialised to .ada/jobs.json, and a controller
 * means nothing once the process that owned it is gone. Dropped as soon as a job settles. */
const aborts = new Map<string, AbortController>();

/** Read the store once, on first use. A missing, unreadable or corrupt file is not an error: jobs
 *  fall back to memory-only, which is exactly how they behaved before they were persisted. */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const p = storePath();
    if (!existsSync(p)) return;
    const { jobs: list, nextSeq } = reviveJobs(JSON.parse(readFileSync(p, "utf8")));
    for (const j of list) jobs.set(j.id, j);
    seq = nextSeq;
  } catch (e) {
    console.error(`jobs: could not read the job store, starting empty (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Keep every running job, and cap the newest finished ones at CAP — the two draw from separate
 * budgets, not one shared window split between them, so a burst of jobs still in flight can never
 * shrink the room finished jobs get.
 *
 * Ranking by start time alone would age out a long job while it is still working — and with it the
 * result that was the entire point of persisting. A running job has no result yet, so dropping it
 * is never the right trade; a finished one has already been readable.
 *
 * Shared between `prune()` — which applies this to this process's own in-memory jobs — and
 * `save()`'s merge, which applies the same rule to the disk-plus-memory view before it is written: a
 * job merged in from another `ada` in the same folder deserves the same cap discipline as one of
 * our own, or the file could grow without bound simply because two processes are both adding to it.
 */
function capJobs(list: Job[]): Job[] {
  const all = [...list].sort((a, b) => b.started - a.started);
  const running = all.filter((j) => j.status === "running");
  // CAP bounds the FINISHED log, independent of how many jobs are in flight — running jobs are
  // extra, exactly as the constant's comment says. Subtracting the running count instead let a
  // burst of concurrent jobs squeeze the finished allowance to zero and destroy their results on
  // the next save, which is the loss persistence exists to prevent.
  const finished = all.filter((j) => j.status !== "running").slice(0, CAP);
  return [...running, ...finished];
}

function prune(): void {
  const keep = new Set(capJobs([...jobs.values()]).map((j) => j.id));
  for (const id of [...jobs.keys()]) if (!keep.has(id)) jobs.delete(id);
}

/** Whole-file write on every status change — three writes per job, of a file capped at 50 finished
 *  entries, plus however many jobs are still running on top of that. A read-only checkout just
 *  keeps its jobs in memory. */
function save(): void {
  try {
    prune();
    const dir = resolve(process.cwd(), ".ada");
    ensureAdaDir(dir);
    const p = join(dir, "jobs.json");
    // Another ada in the same folder — a terminal session beside the app's serve, which the file's
    // own header comment advertises as supported — has its own Map and its own view of this file.
    // Writing ours blind would erase every job it created since we loaded, which is the loss
    // persistence exists to prevent. Merge on the way out; ours wins on a shared id because we are
    // the ones who just changed it. `markRunningInterrupted: false` on the read: a `running` entry
    // here is not stale state left by a dead process the way it would be at load() time — it is that
    // other ada's job, live right now, and rewriting it to "interrupted" would fabricate a crash that
    // never happened, purely because we happened to save while it was still working.
    const merged = new Map<string, Job>();
    try {
      if (existsSync(p)) for (const j of reviveJobs(JSON.parse(readFileSync(p, "utf8")), false).jobs) merged.set(j.id, j);
    } catch {
      /* unreadable or corrupt — our own state is still better than nothing */
    }
    for (const j of jobs.values()) merged.set(j.id, j);
    const out = capJobs([...merged.values()]).sort((a, b) => b.started - a.started);
    writeFileSync(p, JSON.stringify(out, null, 2));
  } catch {
    /* not writable — jobs still work, they just will not outlive this process */
  }
}

/** Every job still in the store, newest first — see `prune`. */
export function listJobs(): Job[] {
  load();
  return [...jobs.values()].sort((a, b) => b.started - a.started);
}

/** Start `run()` in the background; returns a job id immediately. */
export function startJob(task: string, run: (signal?: AbortSignal) => Promise<string>, sessionId?: string): string {
  load();
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now(), sessionId };
  jobs.set(id, job);
  const ac = new AbortController();
  aborts.set(id, ac);
  save();
  const settle = (status: Job["status"], result: string): void => {
    aborts.delete(id);
    // A cancelled job has already been stamped by cancelJob. Its runner then settles moments later —
    // and for the real sub-agent that is a RESOLVE, not a reject: aborting makes send() unwind and
    // return whatever it had. Keep that partial answer, since half an answer beats the word
    // "cancelled", but never let the late settlement move the status off the deliberate stop.
    if (job.status === "cancelled") {
      if (result && job.result === "cancelled") {
        job.result = result;
        save();
      }
      return;
    }
    if (job.status !== "running") return;
    job.status = status;
    job.result = result;
    job.ended = Date.now();
    save();
  };
  run(ac.signal).then(
    (r) => settle("done", r),
    (e) => settle("error", e instanceof Error ? e.message : String(e)),
  );
  return id;
}

/** Stop a running job. Returns the job in its new state, or null if there is no such job.
 *
 * Cancelling something that already finished is a no-op success rather than an error: the user
 * clicked a button that raced the job settling, which is not a failure worth reporting. */
export function cancelJob(id: string): Job | null {
  load();
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status !== "running") return job;
  aborts.get(id)?.abort();
  aborts.delete(id);
  job.status = "cancelled";
  job.result = job.result || "cancelled";
  job.ended = Date.now();
  save();
  return job;
}

export interface SubagentOpts {
  client: OpenAI;
  model: string;
  onApprove: OnApprove;
  autoApprove: boolean;
  reasoning?: "low" | "medium" | "high";
  project: boolean;
  compactAt?: number;
}

const TASK_PARAMS = {
  type: "object" as const,
  properties: { task: { type: "string", description: "The subtask, with all the context the sub-agent needs." } },
  required: ["task"],
  additionalProperties: false,
};

/** Register `spawn_agent` + `background_task`. Call before an Agent snapshots the tool registry. */
export function registerSubagentTools(opts: SubagentOpts): void {
  const sub = (autoApprove: boolean, sessionId?: string): Agent =>
    new Agent({
      client: opts.client,
      model: subagentModel(opts.model), // settings.subagentModel / ADA_SUBAGENT_MODEL — see the note there

      session: Session.create(),
      // The chat that started the chain, inherited so a background_task run BY this sub-agent still
      // records whose it is. Without it a nested job is unattributed and vanishes from the app's
      // per-chat view — present in the store, absent from the only place anyone looks.
      sessionId,
      onApprove: opts.onApprove,
      autoApprove,
      reasoning: opts.reasoning,
      project: opts.project,
      compactAt: opts.compactAt,
    });

  registerTool({
    name: "spawn_agent",
    description: "Delegate a self-contained subtask to a fresh ada sub-agent; returns its final summary. Use for isolated research or a chunk of work handled independently.",
    parameters: TASK_PARAMS,
    needsApproval: false,
    async run(args, ctx) {
      try {
        const text = await sub(opts.autoApprove, ctx?.sessionId).send(String(args.task ?? ""), { quiet: true, delegated: true });
        return { output: text || "(sub-agent returned no text)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: "background_task",
    description:
      "Start a self-contained subtask in the background and return its job id immediately — don't wait for it. Use for long, independent work. Check results with /jobs in the terminal, or the Background jobs section in the app.",
    parameters: TASK_PARAMS,
    needsApproval: false,
    async run(args, ctx) {
      const task = String(args.task ?? "");
      // Mirrors spawn_agent's guard above: an empty reply stored as "" reads as unset to the app
      // (`if (j.result)`), leaving the row silently non-expandable with nothing explaining why.
      const id = startJob(
        task,
        // Threads the job's abort signal into the sub-agent's own SendCtrl, which already checks it
        // at each step — without this, cancelling the job would relabel it "cancelled" while the
        // sub-agent kept running and spending tokens underneath, which is the exact failure this
        // feature exists to fix.
        // The placeholder must not fire on the aborted path: `settle` only keeps partial text (or
        // falls back to "cancelled") when the runner's result is falsy, so stamping empty output
        // with this placeholder here would hand `settle` a truthy string and it would overwrite the
        // "cancelled" sentinel with "(sub-agent returned no text)" instead. Leave it empty when
        // aborted and let `settle` decide.
        (signal) =>
          sub(true, ctx?.sessionId)
            .send(task, { quiet: true, delegated: true, signal })
            .then((text) => (signal?.aborted ? text : text || "(sub-agent returned no text)")),
        ctx?.sessionId,
      );
      return { output: `Started background job ${id}. Check results with /jobs in the terminal, or the Background jobs section in the app (don't wait on it).` };
    },
  });
}

export function renderJobs(): string {
  const all = listJobs();
  if (!all.length) return "(no background jobs)";
  return all
    .map((j) => `${j.id} [${j.status}] ${j.task.slice(0, 60)}${j.result && j.status !== "running" ? `\n   → ${j.result.slice(0, 240)}` : ""}`)
    .join("\n");
}
