// Full-workspace snapshots via git plumbing — capture the entire working tree (tracked + untracked)
// into a git tree object without touching the user's index, and restore it later. Complements the
// per-file checkpoint/undo with a whole-tree save point. ponytail: needs a git repo; restore writes
// snapshotted files back but doesn't delete files created after the snapshot.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(args: string[], env?: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: process.cwd(), env: env ?? process.env });
  return { status: r.status, out: (r.stdout ?? "").trim() };
}

let last: string | null = null;

/** Snapshot the full working tree into a git tree object; returns its SHA (or null if not a repo). */
export function snapshot(): string | null {
  const idx = join(tmpdir(), `ada-snap-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    if (git(["add", "-A", "."], env).status !== 0) return null;
    const tree = git(["write-tree"], env).out || null;
    if (tree) last = tree;
    return tree;
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Restore a snapshot tree (or the last one taken) into the working tree. */
export function restore(tree?: string): boolean {
  const t = tree ?? last;
  if (!t) return false;
  const idx = join(tmpdir(), `ada-snap-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    if (git(["read-tree", t], env).status !== 0) return false;
    return git(["checkout-index", "-a", "-f"], env).status === 0;
  } finally {
    try {
      rmSync(idx, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function hasSnapshot(): boolean {
  return last !== null;
}
