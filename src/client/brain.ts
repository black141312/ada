// Project "brain" — a cached repo map injected into the system prompt so every session starts
// grounded in the current folder (structure + top-level symbols) without the agent grepping first.
// Cheap and dependency-free: walks the tree, extracts symbols with light per-language regex (no
// parser), caps the output to a token budget, and caches to .ada/brain.json keyed by a directory
// fingerprint so it rebuilds only when files change.
// ponytail: regex symbol extraction, not a real parser — good enough for a map; upgrade to tree-sitter
// only if the map quality measurably matters.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", ".ada", ".next", "build", "coverage", "out", "vendor", "target", ".venv", "__pycache__"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cpp|hpp|swift|scala|svelte|vue)$/i;
// The map rides in the system prompt on EVERY request, so its size is a per-call tax. 6k chars
// (~1.5k tokens) still names hundreds of files; the agent greps/searches for anything deeper.
const MAX_CHARS = Number(process.env.ADA_BRAIN_MAX) || 6_000;
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
  symbols: string[];
}

/** Walk the tree collecting code files (path + size only — no file contents read). Bounded by
 *  MAX_FILES. Reading every file to extract symbols is the expensive half, so it's deferred until
 *  we know the cache actually missed. */
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
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (CODE_EXT.test(e.name)) {
        let size: number;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        out.push({ path: relative(root, full).replace(/\\/g, "/"), size, symbols: [] });
      }
    }
  }
  return out;
}

/** Fill in each file's top-level symbols. Only runs on a cache miss — this is the part that reads. */
function addSymbols(root: string, files: FileEntry[]): FileEntry[] {
  for (const f of files) {
    try {
      f.symbols = symbolsOf(readFileSync(join(root, f.path), "utf8"));
    } catch {
      /* unreadable — the path alone still helps */
    }
  }
  return files;
}

/** A fingerprint of the tree's CONTENT — every path and its size, hashed. Deliberately free of
 *  mtimes: each new chat gets a fresh `git worktree add`, and checkout restamps every mtime, so an
 *  mtime-based key missed on every chat and the worktrees kept overwriting each other's cache.
 *  Two identical checkouts now share one cached map, and any add/remove/edit still changes the key. */
function fingerprint(files: FileEntry[]): string {
  const h = createHash("sha1");
  h.update(`v2:${MAX_CHARS}\n`); // budget is part of the key — a smaller map must not reuse a bigger one
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}:${f.size}\n`);
  }
  return h.digest("hex");
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

/** If `cwd` is a git WORKTREE copy, the main project root; else `cwd`. Worktrees have identical
 *  files, so caches belong in the project's own .ada — visible to the user and shared across
 *  sessions instead of rebuilt per worktree. (A worktree's .git is a file: "gitdir: <main>/.git/worktrees/<id>") */
export function projectRootOf(cwd: string): string {
  try {
    const dotGit = resolve(cwd, ".git");
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)[\/\\]\.git[\/\\]worktrees[\/\\]/m);
      if (m?.[1] && existsSync(m[1])) return m[1];
    }
  } catch {
    /* fall through — treat as a normal checkout */
  }
  return cwd;
}

/** Build (or load from cache) the repo map for `cwd`. Returns "" if the folder has no code files. */
export function loadBrain(cwd: string = process.cwd()): string {
  const files = walk(cwd);
  if (!files.length) return "";
  const fp = fingerprint(files);
  const cacheRoot = projectRootOf(cwd);
  const cachePath = resolve(cacheRoot, ".ada", "brain.json");

  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as BrainCache;
      if (cached.fingerprint === fp && cached.map) return cached.map;
    }
  } catch {
    /* stale/corrupt cache — rebuild */
  }

  const map = render(addSymbols(cwd, files)); // cache missed — now pay to read the files
  try {
    mkdirSync(resolve(cacheRoot, ".ada"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fingerprint: fp, map } satisfies BrainCache));
  } catch {
    /* read-only fs — still return the freshly built map */
  }
  return map;
}
