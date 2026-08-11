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
  status: "running" | "done" | "error";
  result?: string;
  started: number;
  ended?: number;
}

/** Newest first, and only this many — a job log is a convenience, not an audit trail. */
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
 */
export function reviveJobs(raw: unknown): { jobs: Job[]; nextSeq: number } {
  if (!Array.isArray(raw)) return { jobs: [], nextSeq: 0 };
  const jobs: Job[] = [];
  let nextSeq = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const j = r as Partial<Job>;
    if (typeof j.id !== "string" || typeof j.task !== "string" || typeof j.started !== "number") continue;
    const n = Number(j.id.replace(/^j/, ""));
    if (Number.isFinite(n) && n > nextSeq) nextSeq = n;
    jobs.push(
      j.status === "running"
        ? { id: j.id, task: j.task, status: "error", result: "interrupted — ada serve restarted", started: j.started, ended: Date.now() }
        : { id: j.id, task: j.task, status: j.status === "error" ? "error" : "done", result: j.result, started: j.started, ended: j.ended },
    );
  }
  return { jobs, nextSeq };
}

const jobs = new Map<string, Job>();
let seq = 0;
let loaded = false;

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

/** Keep every running job, then fill the rest of the window with the newest finished ones.
 *
 * Ranking by start time alone would age out a long job while it is still working — and with it the
 * result that was the entire point of persisting. A running job has no result yet, so dropping it
 * is never the right trade; a finished one has already been readable.
 */
function prune(): void {
  const all = [...jobs.values()].sort((a, b) => b.started - a.started);
  const running = all.filter((j) => j.status === "running");
  const finished = all.filter((j) => j.status !== "running").slice(0, Math.max(0, CAP - running.length));
  const keep = new Set([...running, ...finished].map((j) => j.id));
  for (const id of [...jobs.keys()]) if (!keep.has(id)) jobs.delete(id);
}

/** Whole-file write on every status change — three writes per job, of a file capped at 50 entries.
 *  A read-only checkout just keeps its jobs in memory. */
function save(): void {
  try {
    prune();
    const dir = resolve(process.cwd(), ".ada");
    ensureAdaDir(dir);
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(listJobs(), null, 2));
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
export function startJob(task: string, run: () => Promise<string>): string {
  load();
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now() };
  jobs.set(id, job);
  save();
  run().then(
    (r) => {
      job.status = "done";
      job.result = r;
      job.ended = Date.now();
      save();
    },
    (e) => {
      job.status = "error";
      job.result = e instanceof Error ? e.message : String(e);
      job.ended = Date.now();
      save();
    },
  );
  return id;
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
  const sub = (autoApprove: boolean): Agent =>
    new Agent({
      client: opts.client,
      model: subagentModel(opts.model), // settings.subagentModel / ADA_SUBAGENT_MODEL — see the note there

      session: Session.create(),
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
    async run(args) {
      try {
        const text = await sub(opts.autoApprove).send(String(args.task ?? ""), { quiet: true, delegated: true });
        return { output: text || "(sub-agent returned no text)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: "background_task",
    description: "Start a self-contained subtask in the background and return its job id immediately — don't wait for it. Use for long, independent work. The user checks results with /jobs.",
    parameters: TASK_PARAMS,
    needsApproval: false,
    async run(args) {
      const task = String(args.task ?? "");
      const id = startJob(task, () => sub(true).send(task, { quiet: true, delegated: true }));
      return { output: `Started background job ${id}. Check results with /jobs (don't wait on it).` };
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
