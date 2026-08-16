// Which better-sqlite3 native binary to load.
//
// A compiled .node satisfies exactly ONE Node ABI, and this checkout is used by two runtimes:
//   - the system Node          — `ada` from a terminal, tests, selfcheck        (e.g. ABI 137)
//   - Electron's bundled Node  — the desktop app spawns the agent with          (e.g. ABI 136)
//     ELECTRON_RUN_AS_NODE=1, see ada-app/electron/main.js
//
// Installing the module built for one runtime silently breaks the other, and the failure surfaces
// far from the cause: "NODE_MODULE_VERSION 136 … requires 137" in the middle of a chat. Fixing it
// for one side has flipped the breakage back and forth more than once.
//
// So both binaries are kept side by side as `better_sqlite3-<abi>.node` (see
// scripts/sqlite-abi.mjs) and this picks the one matching the runtime that is actually executing.
// Returns undefined when no per-ABI copy exists, which makes callers fall back to better-sqlite3's
// own default — the previous behaviour, so a tree that never ran the script is no worse off.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);

/** `better_sqlite3-<abi>.node` for THIS runtime, or undefined to use the packaged default. */
export function sqliteNativeBinding(): string | undefined {
  try {
    const root = dirname(require_.resolve("better-sqlite3/package.json"));
    const p = join(root, "build", "Release", `better_sqlite3-${process.versions.modules}.node`);
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined; // better-sqlite3 isn't installed (packaged CLI drops it) — caller handles that
  }
}

/** Options for `new Database(...)`. Spread into a call site: `new DB(path, sqliteOptions())`. */
export function sqliteOptions(): { nativeBinding?: string } {
  const nativeBinding = sqliteNativeBinding();
  // Key omitted when undefined: better-sqlite3 checks `'nativeBinding' in options`, so passing it
  // explicitly as undefined is fine, but omitting keeps the options object honest.
  return nativeBinding ? { nativeBinding } : {};
}
