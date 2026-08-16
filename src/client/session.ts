// Append-only JSONL session store. One OpenAI message per line.
//
// Transcripts used to live inside the project, at `cwd/.ada/sessions`. That tied a conversation's
// memory to a path: rename the folder, move it, or open it by another route (a worktree, a mapped
// drive) and every chat in it came back with nothing, silently. They now live in the home store,
// filed under an id that is kept IN the project and therefore travels with it — so the folder can
// move and the conversations still find their way home.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LEGACY = resolve(process.cwd(), ".ada", "sessions");

/** Where every project's store lives. */
function storeRoot(): string {
  return join(homedir(), ".ada", "sessions");
}

/** This project's identity, stable across renames because it lives inside the project. */
function projectId(): string {
  const f = resolve(process.cwd(), ".ada", "project-id");
  try {
    const id = readFileSync(f, "utf8").trim();
    if (id) return id;
  } catch {
    /* first run here, or unreadable — fall through and write one */
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    // Read-only checkout, or a directory we may not write to. Returning a fresh uuid here would
    // scatter every run into a store of its own, so fall back to something derived from the path:
    // no longer move-proof, but stable, which is the property that actually matters.
    return `path-${createHash("sha256").update(resolve(process.cwd())).digest("hex").slice(0, 16)}`;
  }
}

let dirCache: string | null = null;

/** The store for this project, created and migrated on first use. */
function dir(): string {
  if (dirCache) return dirCache;
  const d = join(storeRoot(), projectId());
  mkdirSync(d, { recursive: true, mode: 0o700 }); // transcripts can contain secrets from tool output
  stampProject(d);
  adoptLegacy(d);
  dirCache = d;
  return d;
}

/**
 * Note which folder this store belongs to. Without it a store is an opaque uuid directory that
 * nothing can ever attribute or clean up. Rewritten whenever the folder has moved, so a renamed
 * project keeps its own breadcrumb current instead of looking abandoned to the next sweep.
 */
function stampProject(d: string): void {
  const f = join(d, "project");
  const here = resolve(process.cwd());
  try {
    if (readFileSync(f, "utf8").trim() === here) return;
  } catch {
    /* not written yet, or unreadable — write it below */
  }
  try {
    writeFileSync(f, `${here}\n`, { mode: 0o600 });
  } catch {
    /* the store works fine without it; only a sweep would be left guessing */
  }
}

export interface StoreInfo {
  dir: string;
  /** The folder this store belongs to, or null if it predates the note and cannot be attributed. */
  project: string | null;
  /** True only when we know the project and it is not there. Unknown is never missing. */
  missing: boolean;
  sessions: number;
}

/** Every store on this machine, so orphans can be found. Ordered oldest-touched first. */
export function stores(): StoreInfo[] {
  const root = storeRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: StoreInfo[] = [];
  for (const n of names) {
    const d = join(root, n);
    let files: string[];
    try {
      if (!statSync(d).isDirectory()) continue;
      files = readdirSync(d);
    } catch {
      continue;
    }
    let project: string | null = null;
    try {
      project = readFileSync(join(d, "project"), "utf8").trim() || null;
    } catch {
      /* no breadcrumb — an older store, or one we could not write */
    }
    out.push({ dir: d, project, missing: !!project && !existsSync(project), sessions: files.filter((f) => f.endsWith(".jsonl")).length });
  }
  return out.sort((a, b) => statSync(a.dir).mtimeMs - statSync(b.dir).mtimeMs);
}

/** Delete one store, transcripts and all. Refuses anything that is not a store. */
export function removeStore(d: string): void {
  const root = storeRoot();
  if (resolve(d) === resolve(root) || dirname(resolve(d)) !== resolve(root)) {
    throw new Error(`refusing to delete ${d}: not a session store`);
  }
  rmSync(d, { recursive: true, force: true });
}

/** Move any transcripts left in the project's own folder into the store, once. */
function adoptLegacy(target: string): void {
  let names: string[];
  try {
    names = readdirSync(LEGACY);
  } catch {
    return; // no old folder — the common case after the first run
  }
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    const to = join(target, f);
    if (existsSync(to)) continue; // already adopted; names carry a timestamp, so this is identity
    try {
      renameSync(join(LEGACY, f), to);
    } catch {
      // Different volume, or the file is held open. A copy still rescues the history, and the
      // existsSync above stops us doing it twice.
      try {
        copyFileSync(join(LEGACY, f), to);
      } catch {
        /* leave it where it is rather than lose it */
      }
    }
  }
}

function ensureDir(): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
}

export type StoredMessage = Record<string, unknown>;

function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 6)}`;
}

export interface SessionMeta {
  file: string;
  mtime: number;
  title: string;
  parent?: string; // file this branch was forked from
}

/**
 * Where a transcript actually is now, or null if it is nowhere.
 *
 * Callers hold paths recorded before the store existed (the desktop app persists one per chat).
 * Those point into the project folder and no longer resolve, but the name is unique — so an old
 * path still names a real transcript, and refusing it would drop exactly the history this store
 * exists to keep.
 */
export function resolveTranscript(file: string): string | null {
  if (!file.endsWith(".jsonl")) return null;
  if (existsSync(file)) return file;
  const moved = join(dir(), basename(file));
  return existsSync(moved) ? moved : null;
}

export class Session {
  readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static create(): Session {
    ensureDir();
    return new Session(join(dir(), `${newId()}.jsonl`));
  }

  static open(file: string): Session {
    return new Session(resolveTranscript(file) ?? file);
  }

  static latest(): Session | null {
    const metas = list();
    return metas[0] ? Session.open(metas[0].file) : null;
  }

  /** Branch: a new session seeded with `messages`, recording its parent for /tree. */
  static fork(parentFile: string, messages: unknown[]): Session {
    ensureDir();
    const s = new Session(join(dir(), `${newId()}.jsonl`));
    s.append({ __meta: { parent: parentFile, branchedAt: messages.length } });
    for (const m of messages) s.append(m);
    return s;
  }

  append(msg: unknown): void {
    try {
      ensureDir();
      appendFileSync(this.file, `${JSON.stringify(msg)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      /* persistence is best-effort; never crash the agent over it */
    }
  }

  load(): StoredMessage[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as StoredMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is StoredMessage => m !== null && !("__meta" in m));
  }
}

export function list(): SessionMeta[] {
  const d = dir();
  const out: SessionMeta[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".jsonl")) continue;
    const file = join(d, f);
    let title = "(empty)";
    let parent: string | undefined;
    try {
      for (const l of readFileSync(file, "utf8").split("\n")) {
        if (!l.trim()) continue;
        const m = JSON.parse(l) as StoredMessage;
        if (m.__meta) {
          parent = (m.__meta as { parent?: string }).parent;
          continue;
        }
        if (m.role === "user" && typeof m.content === "string") {
          title = m.content.slice(0, 60);
          break;
        }
      }
    } catch {
      /* ignore unreadable session */
    }
    out.push({ file, mtime: statSync(file).mtimeMs, title, parent });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
