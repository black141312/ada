// The built-in tools, in OpenAI function-tool shape. read_file is safe; the rest are gated.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { glob as fsGlob } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type * as PtyType from "node-pty";
import { green, renderEditDiff } from "./render.ts";
import * as checkpoint from "./checkpoint.ts";
import { renderTodos, setTodos, type Todo } from "./todos.ts";
import { isTrusted, loadSettings } from "./settings.ts";
import { getDiagnostics } from "./lsp.ts";

const MAX_OUTPUT = 30_000;

export interface ToolResult {
  output: string; // text returned to the model
  isError?: boolean;
  display?: string; // optional rich, user-facing render (e.g. a colored diff)
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  needsApproval: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… [truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

/** Strip HTML to readable text (no dependency) — good enough for "read this page". */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|section|article|tr|h[1-6])>/gi, "\n")
    .replace(/<(?:br|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x?39;|&#x27;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Auto-format a just-written file with a discovered project formatter (best-effort).
// Trust-gated (same gate as extensions/MCP) so a repo can't auto-run a trojan local formatter.
const FORMATTERS: { exts: string[]; bin: string; args: (f: string) => string[] }[] = [
  { exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css", ".scss", ".less", ".html", ".md", ".mdx", ".yaml", ".yml", ".vue", ".svelte", ".graphql"], bin: "prettier", args: (f) => ["--write", f] },
  { exts: [".go"], bin: "gofmt", args: (f) => ["-w", f] },
  { exts: [".rs"], bin: "rustfmt", args: (f) => [f] },
  { exts: [".py"], bin: "ruff", args: (f) => ["format", "-q", f] },
  { exts: [".sh", ".bash"], bin: "shfmt", args: (f) => ["-w", f] },
];
const binCache = new Map<string, string | null>();
function findBin(bin: string): string | null {
  const cached = binCache.get(bin);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  const local = resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? `${bin}.cmd` : bin);
  if (existsSync(local)) found = local;
  else {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
    if (probe.status === 0 && (probe.stdout ?? "").trim()) found = bin;
  }
  binCache.set(bin, found);
  return found;
}

/** Format `abs` in place with a discovered formatter. No-op (returns false) if untrusted, disabled,
 *  or no formatter is available for the extension. Never throws. */
export function formatFile(abs: string): boolean {
  if (process.env.ADA_NO_FORMAT || !isTrusted(process.cwd())) return false;
  const ext = extname(abs).toLowerCase();
  const fmt = FORMATTERS.find((f) => f.exts.includes(ext) && findBin(f.bin));
  if (!fmt) return false;
  try {
    return spawnSync(findBin(fmt.bin)!, fmt.args(abs), { timeout: 10_000, encoding: "utf8", shell: process.platform === "win32" }).status === 0;
  } catch {
    return false;
  }
}

// node-pty gives the bash tool a real terminal. It's a required dependency; if the native build is
// ever broken on a platform, fall back to spawnSync so bash still works.
const pty: typeof PtyType | null = (() => {
  try {
    return createRequire(import.meta.url)("node-pty") as typeof PtyType;
  } catch {
    return null;
  }
})();

// Built via new RegExp (string escapes) so no literal ESC/BEL bytes live in the source.
const ANSI = new RegExp("[\\u001B\\u009B][\\[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])", "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Run a command in a PTY (real terminal); resolves with combined output + exit code. */
function runPty(command: string, timeoutMs = 120_000): Promise<{ output: string; code: number | null }> {
  return new Promise((res) => {
    const win = process.platform === "win32";
    const shell = win ? process.env.COMSPEC ?? "cmd.exe" : process.env.SHELL ?? "/bin/bash";
    const shellArgs = win ? ["/c", command] : ["-lc", command];
    const p = pty!.spawn(shell, shellArgs, { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: process.env as Record<string, string> });
    let out = "";
    const cap = 10 * 1024 * 1024;
    p.onData((d) => {
      if (out.length < cap) out += d;
    });
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ output: out, code });
    };
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    p.onExit(({ exitCode }) => finish(exitCode));
  });
}

/** Block localhost / private / metadata hosts (basic SSRF guard for web_fetch). */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return true;
  }
  return false;
}

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);

// Serialize mutations to the same path so concurrent writes never interleave.
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(abs) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(abs, next.catch(() => undefined));
  return next;
}

// Huge output is spilled to .ada/tmp and replaced by a head + pointer, instead of lost to truncation.
function spillIfHuge(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  try {
    const dir = join(process.cwd(), ".ada", "tmp");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `out-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
    writeFileSync(f, text, "utf8");
    return `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars; full output: ${relative(process.cwd(), f)}]`;
  } catch {
    return truncate(text);
  }
}

function globMatch(rel: string, pattern: string): boolean {
  const p = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::").replace(/\*/g, "[^/]*").replace(/::/g, ".*");
  try {
    return new RegExp(`^${p}$`).test(rel);
  } catch {
    return false;
  }
}

/** A write/edit target is protected if it matches (or contains) a glob in settings.protectedPaths. */
function isProtected(abs: string): boolean {
  const pats = loadSettings(true).protectedPaths;
  if (!pats || !pats.length) return false;
  const rel = relative(process.cwd(), abs).replace(/\\/g, "/");
  return pats.some((g) => rel.includes(g) || abs.includes(g) || globMatch(rel, g));
}

const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\brmdir\b|\bdd\b|mkfs|>\s*\/dev\/|:\(\)\s*\{|git\s+push\b[^\n]*--force|git\s+reset\s+--hard|\bshutdown\b|\breboot\b|\bkillall\b|chmod\s+-R|chown\s+-R/i;
/** True for shell commands dangerous enough to always confirm, even in auto-approve. */
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

export const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Optional offset/limit (1-based line range) for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to cwd or absolute." },
        offset: { type: "number", description: "1-based first line to return." },
        limit: { type: "number", description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const abs = resolve(process.cwd(), String(args.path));
      if (!existsSync(abs)) return { output: `File not found: ${String(args.path)}`, isError: true };
      const ext = extname(abs).toLowerCase();
      if (IMG_EXT.has(ext)) {
        try {
          return { output: `[${ext.slice(1)} image: ${String(args.path)}, ${statSync(abs).size} bytes] — this build cannot view images` };
        } catch (e) {
          return { output: String(e), isError: true };
        }
      }
      try {
        let text = readFileSync(abs, "utf8");
        const offset = Number(args.offset) || 0;
        const limit = Number(args.limit) || 0;
        if (offset > 0 || limit > 0) {
          const lines = text.split("\n");
          const start = offset > 0 ? offset - 1 : 0;
          text = lines.slice(start, limit > 0 ? start + limit : undefined).join("\n");
        }
        return { output: truncate(text) };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Creates parent directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const abs = resolve(process.cwd(), String(args.path));
      const content = String(args.content ?? "");
      return withFileLock(abs, async () => {
        if (isProtected(abs)) return { output: `Refused: ${String(args.path)} is a protected path.`, isError: true };
        checkpoint.record(abs);
        try {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, "utf8");
          const formatted = formatFile(abs);
          return {
            output: `Wrote ${content.length} bytes to ${String(args.path)}${formatted ? " (auto-formatted)" : ""}`,
            display: green(`+ ${String(args.path)} (${content.length} bytes written)${formatted ? " · formatted" : ""}`),
          };
        } catch (e) {
          return { output: String(e), isError: true };
        }
      });
    },
  },
  {
    name: "edit_file",
    description:
      "Replace exact, unique snippet(s) in a file. Each old_text must occur exactly once. " +
      "Pass old_text/new_text for one edit, or an `edits` array of {old_text,new_text} applied in order. " +
      "Matching tolerates CRLF/LF differences; the file's original line endings and BOM are preserved.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        edits: {
          type: "array",
          description: "Multiple edits applied in sequence.",
          items: {
            type: "object",
            properties: { old_text: { type: "string" }, new_text: { type: "string" } },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const abs = resolve(process.cwd(), String(args.path));
      if (!existsSync(abs)) return { output: `File not found: ${String(args.path)}`, isError: true };
      if (isProtected(abs)) return { output: `Refused: ${String(args.path)} is a protected path.`, isError: true };
      const norm = (s: string): string => s.replace(/\r\n/g, "\n");
      const list = Array.isArray(args.edits)
        ? (args.edits as Array<Record<string, unknown>>).map((e) => ({ old: norm(String(e.old_text ?? "")), neu: norm(String(e.new_text ?? "")) }))
        : [{ old: norm(String(args.old_text ?? "")), neu: norm(String(args.new_text ?? "")) }];
      if (!list.length || !list[0]!.old) return { output: "Provide old_text/new_text or a non-empty edits array.", isError: true };
      return withFileLock(abs, async () => {
        let raw: string;
        try {
          raw = readFileSync(abs, "utf8");
        } catch (e) {
          return { output: String(e), isError: true };
        }
        const bom = raw.charCodeAt(0) === 0xfeff;
        if (bom) raw = raw.slice(1);
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        let content = norm(raw);
        for (let i = 0; i < list.length; i++) {
          const { old, neu } = list[i]!;
          if (!old) return { output: `edit ${i + 1}: old_text must not be empty`, isError: true };
          const count = content.split(old).length - 1;
          if (count === 0) return { output: `edit ${i + 1}: old_text not found in ${String(args.path)}`, isError: true };
          if (count > 1) return { output: `edit ${i + 1}: old_text appears ${count} times; add context to make it unique`, isError: true };
          content = content.replace(old, neu);
        }
        let out = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
        if (bom) out = String.fromCharCode(0xfeff) + out;
        checkpoint.record(abs);
        try {
          writeFileSync(abs, out, "utf8");
        } catch (e) {
          return { output: String(e), isError: true };
        }
        const formatted = formatFile(abs);
        const label = list.length > 1 ? `${list.length} changes` : "1 change";
        return { output: `Edited ${String(args.path)} (${label})${formatted ? " · auto-formatted" : ""}`, display: renderEditDiff(String(args.path), list[0]!.old, list[0]!.neu) };
      });
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the working directory through a real PTY (terminal); returns exit code + combined output.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const command = String(args.command);
      if (pty) {
        const { output, code } = await runPty(command);
        return { output: `exit ${code ?? "null"}\n${spillIfHuge(stripAnsi(output).trim() || "(no output)")}`, isError: code !== 0 };
      }
      // fallback: native PTY unavailable on this platform
      const res = spawnSync(command, { shell: true, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd() });
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(no output)";
      return { output: `exit ${res.status ?? "null"}\n${spillIfHuge(out)}`, isError: res.status !== 0 };
    },
  },
  {
    name: "update_todos",
    description: "Maintain the task checklist for the current request. Pass the FULL list each call; mark items done as you finish them. Use for any multi-step task.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } },
            required: ["text", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const items: Todo[] = (Array.isArray(args.todos) ? (args.todos as Array<Record<string, unknown>>) : []).map((t) => ({
        text: String(t.text ?? ""),
        status: (["todo", "doing", "done"].includes(String(t.status)) ? String(t.status) : "todo") as Todo["status"],
      }));
      setTodos(items);
      return { output: `Updated ${items.length} todo(s).`, display: renderTodos() };
    },
  },
  {
    name: "ls",
    description: "List entries in a directory (directories shown with a trailing slash).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path; defaults to the working directory." } },
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const dir = resolve(process.cwd(), String(args.path ?? "."));
      if (!existsSync(dir)) return { output: `Not found: ${String(args.path ?? ".")}`, isError: true };
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        return { output: truncate(entries.join("\n") || "(empty)") };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regular expression; returns matching path:line:text. Recurses, skipping node_modules/.git/dist and binary files.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A JavaScript regular expression." },
        path: { type: "string", description: "File or directory to search; defaults to the working directory." },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      let re: RegExp;
      try {
        re = new RegExp(String(args.pattern), args.ignore_case ? "i" : "");
      } catch (e) {
        return { output: `Invalid regex: ${e instanceof Error ? e.message : e}`, isError: true };
      }
      const root = resolve(process.cwd(), String(args.path ?? "."));
      if (!existsSync(root)) return { output: `Not found: ${String(args.path ?? ".")}`, isError: true };
      const MAX = 200;
      const SKIP = new Set(["node_modules", ".git", "dist", ".ada", ".next", "build", "coverage"]);
      const results: string[] = [];
      const walk = (p: string): void => {
        if (results.length >= MAX) return;
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p);
        } catch {
          return;
        }
        if (st.isDirectory()) {
          let names: string[];
          try {
            names = readdirSync(p);
          } catch {
            return;
          }
          for (const n of names) {
            if (results.length >= MAX) break;
            if (!SKIP.has(n)) walk(join(p, n));
          }
        } else if (st.isFile() && st.size <= 2_000_000) {
          let text: string;
          try {
            text = readFileSync(p, "utf8");
          } catch {
            return;
          }
          if (text.includes(String.fromCharCode(0))) return; // skip binary
          const rel = relative(process.cwd(), p) || p;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              results.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
              if (results.length >= MAX) break;
            }
          }
        }
      };
      walk(root);
      const more = results.length >= MAX ? `\n… (capped at ${MAX} matches)` : "";
      return { output: (results.join("\n") || "(no matches)") + more };
    },
  },
  {
    name: "glob",
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.js"), relative to the working directory.',
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const MAX = 500;
      const matches: string[] = [];
      try {
        for await (const m of fsGlob(String(args.pattern))) {
          if (/(^|[\\/])(node_modules|\.git|dist|\.ada)([\\/]|$)/.test(m)) continue;
          matches.push(m);
          if (matches.length >= MAX) break;
        }
      } catch (e) {
        return { output: String(e), isError: true };
      }
      matches.sort();
      const more = matches.length >= MAX ? `\n… (capped at ${MAX})` : "";
      return { output: (matches.join("\n") || "(no matches)") + more };
    },
  },
  {
    name: "web_fetch",
    description: "Fetch an http(s) URL and return its content as readable text (HTML is stripped to text). Use to read docs, articles, changelogs, or JSON APIs.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, raw: { type: "boolean", description: "return the raw body instead of HTML→text" } },
      required: ["url"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      let url: URL;
      try {
        url = new URL(String(args.url));
      } catch {
        return { output: `Invalid URL: ${String(args.url)}`, isError: true };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return { output: "Only http/https URLs are allowed.", isError: true };
      if (isBlockedHost(url.hostname)) return { output: "Refusing to fetch a localhost/private address.", isError: true };
      try {
        const res = await fetch(url, {
          headers: { "user-agent": "ada/0.0.1 (+https://github.com/black141312/ada)", accept: "text/html,text/plain,application/json,*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        const body = await res.text();
        if (!res.ok) return { output: truncate(`HTTP ${res.status} ${res.statusText} (${url.href})\n\n${body}`), isError: true };
        const text = args.raw || !/html/i.test(ct) ? body : htmlToText(body);
        return { output: truncate(`${url.href} — ${res.status} ${ct}\n\n${text}`) };
      } catch (e) {
        return { output: `fetch failed: ${e instanceof Error ? e.message : e}`, isError: true };
      }
    },
  },
  {
    name: "web_search",
    description: "Search the web; returns the top results (title, URL, snippet). Requires a Brave Search API key (BRAVE_API_KEY). Use to find docs/answers, then web_fetch a result.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const key = process.env.BRAVE_API_KEY ?? process.env.ADA_BRAVE_API_KEY;
      if (!key) return { output: "web_search needs a Brave Search API key — set BRAVE_API_KEY (free tier at brave.com/search/api). For a known page, use web_fetch instead.", isError: true };
      try {
        const u = new URL("https://api.search.brave.com/res/v1/web/search");
        u.searchParams.set("q", String(args.query));
        u.searchParams.set("count", "8");
        const res = await fetch(u, { headers: { "x-subscription-token": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return { output: `Brave search HTTP ${res.status} ${res.statusText}`, isError: true };
        const data = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
        const results = data.web?.results ?? [];
        if (!results.length) return { output: "(no results)" };
        return { output: results.map((r) => `- ${r.title}\n  ${r.url}\n  ${htmlToText(r.description ?? "").slice(0, 200)}`).join("\n\n") };
      } catch (e) {
        return { output: `search failed: ${e instanceof Error ? e.message : e}`, isError: true };
      }
    },
  },
  {
    name: "apply_patch",
    description: "Apply a coordinated change across multiple files in one call. Each file has an action: create (full content), update (exact-match edits), or delete. Prefer this over many edit_file calls for multi-file changes.",
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              action: { type: "string", enum: ["create", "update", "delete"] },
              content: { type: "string", description: "create: the full file content" },
              edits: {
                type: "array",
                description: "update: exact-match replacements applied in order",
                items: { type: "object", properties: { old_text: { type: "string" }, new_text: { type: "string" } }, required: ["old_text", "new_text"], additionalProperties: false },
              },
            },
            required: ["path", "action"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
      if (!files.length) return { output: "No files in patch.", isError: true };
      const lines: string[] = [];
      let anyErr = false;
      const norm = (s: string): string => s.replace(/\r\n/g, "\n");
      for (const f of files) {
        const p = String(f.path ?? "");
        const abs = resolve(process.cwd(), p);
        const action = String(f.action);
        if (isProtected(abs)) {
          lines.push(`✗ ${p}: protected path`);
          anyErr = true;
          continue;
        }
        try {
          if (action === "delete") {
            if (!existsSync(abs)) {
              lines.push(`✗ ${p}: not found`);
              anyErr = true;
              continue;
            }
            checkpoint.record(abs);
            rmSync(abs);
            lines.push(`− ${p} (deleted)`);
          } else if (action === "create") {
            checkpoint.record(abs);
            mkdirSync(dirname(abs), { recursive: true });
            const content = String(f.content ?? "");
            writeFileSync(abs, content, "utf8");
            const fmt = formatFile(abs);
            lines.push(`+ ${p} (${content.length} bytes${fmt ? ", formatted" : ""})`);
          } else if (action === "update") {
            if (!existsSync(abs)) {
              lines.push(`✗ ${p}: not found`);
              anyErr = true;
              continue;
            }
            let raw = readFileSync(abs, "utf8");
            const bom = raw.charCodeAt(0) === 0xfeff;
            if (bom) raw = raw.slice(1);
            const eol = raw.includes("\r\n") ? "\r\n" : "\n";
            let content = norm(raw);
            const edits = Array.isArray(f.edits) ? (f.edits as Array<Record<string, unknown>>) : [];
            let ok = true;
            for (const e of edits) {
              const old = norm(String(e.old_text ?? ""));
              const neu = norm(String(e.new_text ?? ""));
              const count = old ? content.split(old).length - 1 : 0;
              if (count !== 1) {
                lines.push(`✗ ${p}: an edit matched ${count} times (must be exactly 1)`);
                anyErr = true;
                ok = false;
                break;
              }
              content = content.replace(old, neu);
            }
            if (!ok) continue;
            checkpoint.record(abs);
            let out = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
            if (bom) out = String.fromCharCode(0xfeff) + out;
            writeFileSync(abs, out, "utf8");
            const fmt = formatFile(abs);
            lines.push(`~ ${p} (${edits.length} edit${edits.length === 1 ? "" : "s"}${fmt ? ", formatted" : ""})`);
          } else {
            lines.push(`✗ ${p}: unknown action "${action}"`);
            anyErr = true;
          }
        } catch (e) {
          lines.push(`✗ ${p}: ${e instanceof Error ? e.message : e}`);
          anyErr = true;
        }
      }
      return { output: lines.join("\n"), isError: anyErr };
    },
  },
  {
    name: "lsp_diagnostics",
    description: "Get language-server diagnostics (errors/warnings) for a file — call after editing to check it compiles/type-checks. Needs the language server installed (typescript-language-server, pyright, gopls, rust-analyzer) in a trusted project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const abs = resolve(process.cwd(), String(args.path));
      if (!existsSync(abs)) return { output: `File not found: ${String(args.path)}`, isError: true };
      try {
        const diags = await getDiagnostics(abs);
        return { output: diags.length ? diags.join("\n") : "No diagnostics (clean, or no language server available for this file)." };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  },
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));

/** Register a dynamic tool (from an extension, skill, or MCP server). Last registration wins. */
export function registerTool(t: Tool): void {
  const existing = tools.findIndex((x) => x.name === t.name);
  if (existing >= 0) tools.splice(existing, 1);
  tools.push(t);
  toolByName.set(t.name, t);
}
