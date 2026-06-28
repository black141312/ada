// The built-in tools, in OpenAI function-tool shape. read_file is safe; the rest are gated.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { glob as fsGlob } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { green, renderEditDiff } from "./render.ts";
import * as checkpoint from "./checkpoint.ts";
import { renderTodos, setTodos, type Todo } from "./todos.ts";
import { loadSettings } from "./settings.ts";

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
          return {
            output: `Wrote ${content.length} bytes to ${String(args.path)}`,
            display: green(`+ ${String(args.path)} (${content.length} bytes written)`),
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
        const bom = raw.startsWith("\uFEFF");
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
        if (bom) out = `\uFEFF${out}`;
        checkpoint.record(abs);
        try {
          writeFileSync(abs, out, "utf8");
        } catch (e) {
          return { output: String(e), isError: true };
        }
        const label = list.length > 1 ? `${list.length} changes` : "1 change";
        return { output: `Edited ${String(args.path)} (${label})`, display: renderEditDiff(String(args.path), list[0]!.old, list[0]!.neu) };
      });
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the working directory; returns exit code + combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const res = spawnSync(String(args.command), {
        shell: true,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      });
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(no output)";
      const code = res.status;
      return { output: `exit ${code ?? "null"}\n${spillIfHuge(out)}`, isError: code !== 0 };
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
];

export const toolByName = new Map(tools.map((t) => [t.name, t]));

/** Register a dynamic tool (from an extension, skill, or MCP server). Last registration wins. */
export function registerTool(t: Tool): void {
  const existing = tools.findIndex((x) => x.name === t.name);
  if (existing >= 0) tools.splice(existing, 1);
  tools.push(t);
  toolByName.set(t.name, t);
}
