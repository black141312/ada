// Project "brain" — a cached repo map injected into the system prompt so every session starts
// grounded in the current folder (structure + top-level symbols) without the agent grepping first.
// Cheap and dependency-free: walks the tree, extracts symbols with light per-language regex (no
// parser), caps the output to a token budget, and caches to .ada/brain.json keyed by a directory
// fingerprint so it rebuilds only when files change.
// ponytail: regex symbol extraction, not a real parser — good enough for a map; upgrade to tree-sitter
// only if the map quality measurably matters.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", ".ada", ".next", "build", "coverage", "out", "vendor", "target", ".venv", "__pycache__"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|swift|scala|svelte|vue)$/i;
const MAX_CHARS = Number(process.env.ADA_BRAIN_MAX) || 12_000; // ~3k tokens
const MAX_FILES = 4000; // walk cap — don't crawl a monorepo forever
const MAX_FILE_BYTES = 300_000;

// Per-language regexes for top-level definitions. Kept deliberately loose — one capture group = the name.
const SYMBOL_RES: RegExp[] = [
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, // js/ts function
  /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, // js/ts/py/java class
  /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, // js/ts arrow fn
  /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, // ts type
  /^\s*def\s+([A-Za-z_][\w]*)/gm, // python def
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm, // go func (incl. methods)
  /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g, // rust fn
];

function symbolsOf(src: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const re of SYMBOL_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const n = m[1];
      if (n && !seen.has(n) && n.length > 1) {
        seen.add(n);
        names.push(n);
      }
    }
  }
  return names.slice(0, 12); // a handful per file is enough to orient
}

interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  symbols: string[];
}

/** Walk the tree collecting code files + their top-level symbols. Bounded by MAX_FILES. */
function walk(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".ada") {
        if (SKIP.has(e.name)) continue;
      }
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (CODE_EXT.test(e.name)) {
        let st: import("node:fs").Stats;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        let symbols: string[] = [];
        try {
          symbols = symbolsOf(readFileSync(full, "utf8"));
        } catch {
          /* unreadable — list the path anyway */
        }
        out.push({ path: relative(root, full).replace(/\\/g, "/"), size: st.size, mtime: Math.round(st.mtime.getTime()), symbols });
      }
    }
  }
  return out;
}

/** A cheap fingerprint of the tree — count + newest mtime + total size. Changes when files are
 *  added, removed, or edited; stable otherwise so the map is only rebuilt when the folder does. */
function fingerprint(files: FileEntry[]): string {
  let newest = 0;
  let total = 0;
  for (const f of files) {
    if (f.mtime > newest) newest = f.mtime;
    total += f.size;
  }
  return `${files.length}:${newest}:${total}`;
}

function render(files: FileEntry[]): string {
  // Files with the most symbols first — those are usually the load-bearing ones.
  const ranked = [...files].sort((a, b) => b.symbols.length - a.symbols.length);
  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const f of ranked) {
    const line = f.symbols.length ? `${f.path} — ${f.symbols.join(", ")}` : f.path;
    if (chars + line.length > MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
    shown++;
  }
  // Keep the listing readable — sort the shown subset back into path order.
  lines.sort();
  const omitted = files.length - shown;
  const header = `${files.length} code files${omitted > 0 ? ` (${shown} mapped, ${omitted} omitted for size)` : ""}:`;
  return `${header}\n${lines.join("\n")}`;
}

interface BrainCache {
  fingerprint: string;
  map: string;
}

/** Build (or load from cache) the repo map for `cwd`. Returns "" if the folder has no code files. */
export function loadBrain(cwd: string = process.cwd()): string {
  const files = walk(cwd);
  if (!files.length) return "";
  const fp = fingerprint(files);
  const cachePath = resolve(cwd, ".ada", "brain.json");

  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as BrainCache;
      if (cached.fingerprint === fp && cached.map) return cached.map;
    }
  } catch {
    /* stale/corrupt cache — rebuild */
  }

  const map = render(files);
  try {
    mkdirSync(resolve(cwd, ".ada"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fingerprint: fp, map } satisfies BrainCache));
  } catch {
    /* read-only fs — still return the freshly built map */
  }
  return map;
}
