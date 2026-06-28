// File checkpoint: the first time the agent touches a file, we record its original content
// (null = it didn't exist). `/undo` restores everything and removes files the agent created.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const original = new Map<string, string | null>();

export function record(abs: string): void {
  if (original.has(abs)) return; // keep the earliest (pre-agent) state
  original.set(abs, existsSync(abs) ? safeRead(abs) : null);
}

function safeRead(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function pendingCount(): number {
  return original.size;
}

export function undoAll(): string {
  if (!original.size) return "Nothing to undo — the agent hasn't changed any files.";
  let restored = 0;
  let removed = 0;
  for (const [abs, content] of original) {
    try {
      if (content === null) {
        if (existsSync(abs)) {
          rmSync(abs, { force: true });
          removed++;
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        restored++;
      }
    } catch {
      /* best-effort */
    }
  }
  original.clear();
  return `Undid agent changes: ${restored} file(s) restored${removed ? `, ${removed} new file(s) removed` : ""}.`;
}
