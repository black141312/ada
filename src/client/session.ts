// Append-only JSONL session store under .ada/sessions/. One OpenAI message per line.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(process.cwd(), ".ada", "sessions");

export type StoredMessage = Record<string, unknown>;

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 }); // transcripts can contain secrets from tool output
}

function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 6)}`;
}

export interface SessionMeta {
  file: string;
  mtime: number;
  title: string;
  parent?: string; // file this branch was forked from
}

export class Session {
  readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static create(): Session {
    ensureDir();
    return new Session(join(DIR, `${newId()}.jsonl`));
  }

  static open(file: string): Session {
    return new Session(file);
  }

  static latest(): Session | null {
    const metas = list();
    return metas[0] ? Session.open(metas[0].file) : null;
  }

  /** Branch: a new session seeded with `messages`, recording its parent for /tree. */
  static fork(parentFile: string, messages: unknown[]): Session {
    ensureDir();
    const s = new Session(join(DIR, `${newId()}.jsonl`));
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
  ensureDir();
  const out: SessionMeta[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    const file = join(DIR, f);
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
