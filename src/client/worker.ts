// Isolated sub-agent execution: each worker gets its own git worktree, and only the files it
// actually changed are copied back.
//
// Why a child process rather than an in-process Agent: the tool layer resolves every path against
// process.cwd() (~23 call sites), and workers run concurrently under Promise.all. process.chdir()
// is process-global, so parallel in-process workers physically cannot have separate directories —
// they'd all write into the parent's tree. That is exactly what we observed: a "list three colors"
// swarm left colors.txt, color_names.txt, extract_colors.py and hex_colors_formatted.txt in the
// repo and edited README.md.
//
// ponytail: ~2s of process startup per worker. Worth it only because workers are the cheap half —
// if that ever dominates, the alternative is threading a cwd through the tool layer, not a pool.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface WorkerRun {
  text: string;
  usage: string;
  /** Repo-relative paths the worker created or modified, already copied into the parent's tree. */
  changed: string[];
  /** Paths skipped because another worker got there first — a decomposition that assigned the same
   *  file twice. Surfaced rather than silently resolved; last-writer-wins hides a planning bug. */
  collided: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The repo root for `cwd`, or null when it isn't a git worktree at all. */
export function repoRoot(cwd: string): string | null {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }
}

/** Run one worker in its own worktree. Returns null when isolation isn't available, so the caller
 *  can fall back to running in-process rather than failing the subtask. */
export async function runIsolatedWorker(opts: {
  cwd: string;
  prompt: string;
  model: string;
  binPath: string;
  /** Prompt-token ceiling for this worker; 0 to leave it uncapped. */
  budget?: number;
  claim: (paths: string[]) => { taken: string[]; collided: string[] };
  signal?: AbortSignal;
}): Promise<WorkerRun | null> {
  const root = repoRoot(opts.cwd);
  if (!root) return null; // not a repo — nothing to branch from

  const dir = join(tmpdir(), "ada-worker", `w-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  let head: string;
  try {
    head = git(["rev-parse", "HEAD"], root);
    mkdirSync(dirname(dir), { recursive: true });
    git(["worktree", "add", "--detach", dir, head], root);
  } catch {
    return null; // no commits yet, or worktree unsupported — caller falls back
  }

  try {
    const out = await run(opts.binPath, ["-p", opts.prompt, "--json", "--model", opts.model], dir, opts.signal, opts.budget);
    const line = out.split("\n").filter((l) => l.trim().startsWith("{")).pop();
    const parsed = line ? (JSON.parse(line) as { text?: string; usage?: string }) : {};

    // `git status` in the worktree is the exact set the worker touched — no guessing, no mtimes.
    // -uall is load-bearing: the default collapses an untracked directory to a single "assets/"
    // entry, so every file inside it is invisible here and silently never copied back. Observed:
    // a worker created assets/README.md and only index/styles/script came home.
    const status = git(["status", "--porcelain", "-uall"], dir);
    const paths = status
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((p) => p.replace(/^"|"$/g, ""));

    const { taken, collided } = opts.claim(paths);
    for (const p of taken) {
      const from = resolve(dir, p);
      const to = resolve(opts.cwd, p);
      if (!existsSync(from)) continue; // worker deleted it; deletions are not propagated
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    return { text: parsed.text ?? "", usage: parsed.usage ?? "", changed: taken, collided };
  } finally {
    try {
      git(["worktree", "remove", "--force", dir], root);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function run(bin: string, args: string[], cwd: string, signal?: AbortSignal, budget?: number): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      // ADA_TRUST_CWD: the worktree isn't in trustedDirs, and without it the worker loses the repo
      // map — the thing that stopped it groping around to orient itself.
      // ADA_NO_SUBAGENTS: a worker must not fan out again; nesting swarms is unbounded spend.
      // ADA_TOKEN_BUDGET: the leash. The child enforces it itself, since only it can see its own
      // token count — the parent learns the total only after the child has already spent it.
      env: { ...process.env, ADA_TRUST_CWD: "1", ADA_NO_SUBAGENTS: "1", ...(budget ? { ADA_TOKEN_BUDGET: String(budget) } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const kill = () => child.kill();
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", rej);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (code === 0 || out.includes("{")) res(out);
      else rej(new Error(err.trim().slice(-400) || `worker exited ${code}`));
    });
  });
}
