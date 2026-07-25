// Fire-and-forget background jobs: kick off a long, independent subtask without blocking the main
// loop; check results later with /jobs. ponytail: in-memory, single process — jobs vanish on exit.
//
// Also home to the two delegation tools, since both spawn a sub-agent: `spawn_agent` (wait for the
// answer) and `background_task` (don't). They live here rather than in the CLI's interactive branch
// so `ada serve` — the editor — registers them too.

import type OpenAI from "openai";
import { Agent, type OnApprove } from "./agent.ts";
import { Session } from "./session.ts";
import { registerTool } from "./tools.ts";

interface Job {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  result?: string;
  started: number;
}

const jobs = new Map<string, Job>();
let seq = 0;

/** Start `run()` in the background; returns a job id immediately. */
export function startJob(task: string, run: () => Promise<string>): string {
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now() };
  jobs.set(id, job);
  run().then(
    (r) => {
      job.status = "done";
      job.result = r;
    },
    (e) => {
      job.status = "error";
      job.result = e instanceof Error ? e.message : String(e);
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
      model: opts.model,
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
        const text = await sub(opts.autoApprove).send(String(args.task ?? ""), { quiet: true });
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
      const id = startJob(task, () => sub(true).send(task, { quiet: true }));
      return { output: `Started background job ${id}. Check results with /jobs (don't wait on it).` };
    },
  });
}

export function renderJobs(): string {
  const all = [...jobs.values()];
  if (!all.length) return "(no background jobs)";
  return all
    .map((j) => `${j.id} [${j.status}] ${j.task.slice(0, 60)}${j.result && j.status !== "running" ? `\n   → ${j.result.slice(0, 240)}` : ""}`)
    .join("\n");
}
