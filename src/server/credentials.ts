// Credential store at ~/.ada/credentials.json. Holds API keys and OAuth tokens so the
// backend can use them as provider keys. Writes are atomic (temp + rename) and guarded by a
// coarse cross-process lock (an atomically-created lock dir) so a token refresh can't race.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE = join(homedir(), ".ada", "credentials.json");

export interface Credential {
  type: "api_key" | "oauth";
  key?: string; // api_key
  access?: string; // oauth access token
  refresh?: string; // oauth refresh token
  expires?: number; // epoch ms
}

type Store = Record<string, Credential>;

function read(): Store {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(s: Store): void {
  // Owner-only: this file holds raw provider API keys + OAuth tokens. writeFileSync's mode applies to
  // the freshly-created tmp inode; chmodSync then guarantees 0600 even if credentials.json pre-existed
  // with looser perms. (On Windows chmod only toggles read-only — POSIX/Docker is where this matters.)
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, FILE); // atomic replace
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* best-effort */
  }
}

async function withLock<T>(fn: () => T): Promise<T> {
  mkdirSync(dirname(FILE), { recursive: true }); // ensure ~/.ada exists so the lock dir can be created
  const lock = `${FILE}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock); // mkdir is atomic: succeeds for exactly one holder
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true }); // break a stale lock from a crashed run
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (i >= 50) throw new Error("could not acquire credential lock");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function getCredential(provider: string): Credential | undefined {
  return read()[provider];
}

export function listCredentials(): string[] {
  return Object.keys(read());
}

export async function setCredential(provider: string, cred: Credential): Promise<void> {
  await withLock(() => {
    const s = read();
    s[provider] = cred;
    write(s);
  });
}

export async function deleteCredential(provider: string): Promise<void> {
  await withLock(() => {
    const s = read();
    delete s[provider];
    write(s);
  });
}
