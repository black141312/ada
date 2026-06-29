// Fire-and-forget background jobs: kick off a long, independent subtask without blocking the main
// loop; check results later with /jobs. ponytail: in-memory, single process — jobs vanish on exit.

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

export function renderJobs(): string {
  const all = [...jobs.values()];
  if (!all.length) return "(no background jobs)";
  return all
    .map((j) => `${j.id} [${j.status}] ${j.task.slice(0, 60)}${j.result && j.status !== "running" ? `\n   → ${j.result.slice(0, 240)}` : ""}`)
    .join("\n");
}
