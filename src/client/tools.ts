// The built-in tools, in OpenAI function-tool shape. read_file is safe; the rest are gated.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { scrubbedEnv } from "./secret-env.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { glob as fsGlob } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type * as PtyType from "node-pty";
import { green, renderEditDiff } from "./render.ts";
import * as checkpoint from "./checkpoint.ts";
import { renderTodos, setTodos, type Todo } from "./todos.ts";
import { isTrusted, loadSettings } from "./settings.ts";
import { getDiagnostics } from "./lsp.ts";
import { buildPptx, type PptxSlideSpec } from "./pptx.ts";
import { buildDocx, type DocxBlock } from "./docx.ts";
import { browserAction } from "./browser.ts";

// Every tool result is appended to the transcript and resent on each subsequent step, so an
// oversized result is paid for again and again. 12k chars (~3k tokens) is ample for a file slice or
// a listing; the model can re-read with offset/limit when it genuinely needs more.
const MAX_OUTPUT = Number(process.env.ADA_MAX_TOOL_OUTPUT) || 12_000;

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
  /** Big schema, rarely wanted: advertised only when the conversation asks for it (see
   *  wantsLazyTools in agent.ts). Every tool schema is resent on every request, so keeping the
   *  document/image generators out of a "hi" saves ~1k tokens a call. */
  lazy?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… [truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

// The front-end (CLI/TUI) installs an asker so the ask_user tool can prompt the user mid-task.
type Asker = (question: string, options?: string[]) => Promise<string>;
let asker: Asker | null = null;
export function setAsker(fn: Asker | null): void {
  asker = fn;
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
    return spawnSync(findBin(fmt.bin)!, fmt.args(abs), { timeout: 10_000, encoding: "utf8", shell: process.platform === "win32", env: scrubbedEnv() }).status === 0;
  } catch {
    return false;
  }
}

// node-pty gives the bash tool a real terminal. It's a required dependency; if the native build is
// ever broken on a platform, fall back to spawnSync so bash still works. Loaded LAZILY on the first
// bash call: merely loading the native module on Windows sets up async handles whose teardown races
// process.exit and prints "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — commands that
// never spawn a PTY (--version, catalog, --list-models, …) shouldn't pay that.
let ptyMod: typeof PtyType | null | undefined;
function getPty(): typeof PtyType | null {
  if (ptyMod === undefined) {
    try {
      ptyMod = createRequire(import.meta.url)("node-pty") as typeof PtyType;
    } catch {
      ptyMod = null;
    }
  }
  return ptyMod;
}

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
    const p = getPty()!.spawn(shell, shellArgs, { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: scrubbedEnv() });
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

// Note the /dev/ rule excludes the standard sinks (>/dev/null, 2>/dev/null, /dev/stdout, …) — those
// are everyday redirects, not device-overwrites like `> /dev/sda`.
const DESTRUCTIVE = /\brm\s+-[a-z]*[rf]|\brmdir\b|\bdd\b|mkfs|>\s*\/dev\/(?!(?:null|stdout|stderr|tty|zero|u?random)(?:$|[\s>;&|])|fd\/)|:\(\)\s*\{|git\s+push\b[^\n]*--force|git\s+reset\s+--hard|\bshutdown\b|\breboot\b|\bkillall\b|chmod\s+-R|chown\s+-R/i;
/** True for shell commands dangerous enough to always confirm, even in auto-approve. */
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

/** Anything the page would have to fetch from the network to render correctly. A page that needs a
 *  CDN isn't a file you can send someone — it's a file that breaks offline, behind a proxy, or the
 *  day the CDN moves. Images degrade (alt text shows); scripts and stylesheets do not, so those are
 *  the ones worth refusing over. */
function externalRefs(html: string): { fatal: string[]; soft: string[] } {
  const fatal: string[] = [];
  const soft: string[] = [];
  const push = (list: string[], what: string): void => {
    if (!list.includes(what) && list.length < 6) list.push(what);
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/([^"']+)/gi)) push(fatal, `<script src="${m[2]?.slice(0, 60)}">`);
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["'](https?:)?\/\/([^"']+)/gi)) push(fatal, `<link href="${m[2]?.slice(0, 60)}">`);
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?(https?:)?\/\/([^"')]+)/gi)) push(fatal, `@import ${m[2]?.slice(0, 60)}`);
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/([^"']+)/gi)) push(soft, `<img src="${m[2]?.slice(0, 60)}">`);
  return { fatal, soft };
}

export const tools: Tool[] = [
  {
    // Ada could always write HTML with write_file. What this adds is the contract: the page has to
    // stand alone, it lands somewhere predictable, and the user gets a path plus an open window
    // instead of a filename buried in prose.
    name: "create_page",
    lazy: true,
    description:
      "Write a self-contained HTML page (report, dashboard, comparison, one-pager) and open it in the browser. Everything must be inline — no CDN scripts, stylesheets or webfonts — so the file works offline and when sent to someone. Embed images as data: URIs. A bare filename lands in docs/. Load the `web-page` skill first for the design rules - or `web-deck` when it's a presentation, which must be slidable (arrow keys, one slide per screen), not one long scrolling page. When the user's wording doesn't pin the format - 'a presentation', 'a report', 'an overview' - ask_user first which they want: a .pptx (editable in PowerPoint, sends as a file) or an HTML page (opens in a browser, one file to share). Don't ask when they said deck/slides/pptx or page/one-pager.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Output file, ending in .html. A bare filename goes to docs/." },
        html: { type: "string", description: "The complete document, starting with <!doctype html>." },
        open: { type: "boolean", description: "Open it in the default browser (default true)." },
      },
      required: ["path", "html"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const rel = String(args.path);
      const html = String(args.html ?? "");
      if (!/\.html?$/i.test(rel)) return { output: `create_page: path must end in .html (got ${rel})`, isError: true };
      if (html.trim().length < 200) return { output: "create_page: that's not a page — write the real document, not a stub.", isError: true };

      const { fatal, soft } = externalRefs(html);
      if (fatal.length) {
        return {
          output:
            `create_page: the page pulls ${fatal.length} resource(s) off the network, so it won't render offline or for anyone you send it to:\n` +
            fatal.map((f) => `  - ${f}`).join("\n") +
            "\nInline the CSS/JS, and use a system font stack instead of a webfont.",
          isError: true,
        };
      }

      // A bare filename belongs somewhere findable, not scattered in the repo root.
      const abs = rel.includes("/") || rel.includes("\\") || isAbsolute(rel) ? resolve(process.cwd(), rel) : resolve(process.cwd(), "docs", rel);
      if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
      try {
        mkdirSync(dirname(abs), { recursive: true });
        checkpoint.record(abs);
        writeFileSync(abs, html);
      } catch (e) {
        return { output: `create_page: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }

      let opened = "";
      if (args.open !== false) {
        const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", abs]] : process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]];
        try {
          spawnSync(cmd[0] as string, cmd[1] as string[], { timeout: 10_000, stdio: "ignore" });
          opened = " and opened it in your browser";
        } catch {
          /* headless or no handler — the path below is still the answer */
        }
      }
      const warn = soft.length ? `\nHeads up: ${soft.length} image(s) load from the network and will be blank offline — ${soft.join(", ")}` : "";
      return { output: `Wrote ${(html.length / 1024).toFixed(1)} kB${opened}.\n\nOpen it here: ${abs}${warn}` };
    },
  },
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
      if (getPty()) {
        const { output, code } = await runPty(command);
        return { output: `exit ${code ?? "null"}\n${spillIfHuge(stripAnsi(output).trim() || "(no output)")}`, isError: code !== 0 };
      }
      // fallback: native PTY unavailable on this platform
      const res = spawnSync(command, { shell: true, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd(), env: scrubbedEnv() });
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(no output)";
      return { output: `exit ${res.status ?? "null"}\n${spillIfHuge(out)}`, isError: res.status !== 0 };
    },
  },
  {
    // Lets the agent check its own UI work instead of asking the user "does it look right?".
    // Lazy — most turns never touch a browser, and the schema shouldn't ride along for them.
    name: "browser",
    lazy: true,
    description:
      "Look at a page in a real browser: `open` navigates and reports the title + console, `screenshot` saves a png, `text` returns the rendered text, `console` returns logs and errors. Use after changing UI to verify it renders and the console is clean.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "screenshot", "text", "console"] },
        url: { type: "string", description: "Page to load first, e.g. http://localhost:5173. Omit to act on the page already open." },
        path: { type: "string", description: "screenshot only: output file ending in .png." },
        width: { type: "number", description: "Viewport width (default 1280)." },
        height: { type: "number", description: "Viewport height (default 800)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const action = String(args.action) as "open" | "screenshot" | "text" | "console";
      const url = args.url ? String(args.url) : undefined;
      if (url && !/^https?:\/\//i.test(url)) return { output: `browser: url must start with http:// or https:// (got ${url})`, isError: true };
      try {
        const r = await browserAction(action, url, Number(args.width) || 1280, Number(args.height) || 800);
        if (!r.screenshot) return { output: truncate(r.text) };
        const rel = String(args.path ?? "screenshot.png");
        const abs = resolve(process.cwd(), rel.toLowerCase().endsWith(".png") ? rel : `${rel}.png`);
        if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, r.screenshot);
        return { output: `Screenshot of ${r.text} → ${abs}` };
      } catch (e) {
        return { output: `browser: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  },
  {
    // A .ipynb is JSON whose `source` is an array of lines — models edit it badly as raw text
    // (they reflow it into one string, or drop the trailing newlines, and Jupyter stops rendering).
    // Lazy: only worth its schema in a conversation that's actually about notebooks.
    name: "notebook_edit",
    lazy: true,
    description:
      "Edit one cell of a Jupyter notebook (.ipynb) by index: replace its source, insert a new cell before it, or delete it. Editing a code cell clears its stale outputs. Read the notebook first with read_file to find the cell.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .ipynb file." },
        cell: { type: "number", description: "0-based cell index. For insert, the new cell lands at this position." },
        mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Default replace." },
        source: { type: "string", description: "New cell contents (required for replace/insert)." },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "insert only; default code." },
      },
      required: ["path", "cell"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const rel = String(args.path);
      const abs = resolve(process.cwd(), rel);
      if (extname(abs).toLowerCase() !== ".ipynb") return { output: `notebook_edit: not a notebook: ${rel}`, isError: true };
      if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
      const mode = String(args.mode ?? "replace");
      const idx = Number(args.cell);
      let nb: { cells?: unknown[]; nbformat?: number };
      try {
        nb = JSON.parse(readFileSync(abs, "utf8")) as typeof nb;
      } catch (e) {
        return { output: `notebook_edit: ${abs} is not readable JSON — ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      const cells = nb.cells;
      if (!Array.isArray(cells)) return { output: `notebook_edit: ${rel} has no cells array — is it a notebook?`, isError: true };
      const upper = mode === "insert" ? cells.length : cells.length - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx > upper) {
        return { output: `notebook_edit: cell ${args.cell} is out of range (notebook has ${cells.length} cells).`, isError: true };
      }
      // nbformat stores source as a list of lines, each keeping its trailing newline except the last.
      const lines = (s: string): string[] => s.split("\n").map((l, i, a) => (i === a.length - 1 ? l : `${l}\n`)).filter((l, i, a) => l !== "" || i < a.length - 1);

      if (mode === "delete") {
        cells.splice(idx, 1);
      } else if (mode === "insert") {
        if (args.source == null) return { output: "notebook_edit: insert needs `source`.", isError: true };
        const type = String(args.cell_type ?? "code");
        cells.splice(idx, 0, type === "markdown" ? { cell_type: "markdown", metadata: {}, source: lines(String(args.source)) } : { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: lines(String(args.source)) });
      } else {
        if (args.source == null) return { output: "notebook_edit: replace needs `source`.", isError: true };
        const cell = cells[idx] as { cell_type?: string; source?: unknown; outputs?: unknown[]; execution_count?: number | null };
        cell.source = lines(String(args.source));
        if (cell.cell_type === "code") {
          cell.outputs = []; // the old output described the old code
          cell.execution_count = null;
        }
      }
      checkpoint.record(abs); // so /undo covers notebook edits like any other write
      writeFileSync(abs, `${JSON.stringify(nb, null, 1)}\n`); // indent 1 — what Jupyter itself writes
      return { output: `${mode === "delete" ? "Deleted" : mode === "insert" ? "Inserted" : "Replaced"} cell ${idx} in ${rel} (${cells.length} cells now).` };
    },
  },
  {
    // Read-only on purpose: reading history is safe and constantly needed, while commit/push/reset
    // rewrite the user's repo — those stay in `bash`, where they show up in the approval prompt as
    // the actual command being run.
    name: "git",
    description:
      "Inspect the repository: status, diff (staged with `staged`), log, show, blame, branch. Read-only — to commit, push, checkout or reset, use `bash` so the user sees the exact command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["status", "diff", "log", "show", "blame", "branch"] },
        path: { type: "string", description: "Limit to a file or directory (blame requires it)." },
        rev: { type: "string", description: "Commit, branch or range — e.g. HEAD~3, main..HEAD. `show` defaults to HEAD." },
        staged: { type: "boolean", description: "diff only: show the staged changes instead of the working tree." },
        limit: { type: "number", description: "log only: how many commits (default 20)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const cmd = String(args.command);
      const path = args.path ? String(args.path) : "";
      const rev = args.rev ? String(args.rev) : "";
      // Everything goes through argv — never a shell string — so a path or rev can't inject.
      const argv: Record<string, string[]> = {
        status: ["status", "--short", "--branch"],
        diff: ["diff", ...(args.staged ? ["--staged"] : []), ...(rev ? [rev] : [])],
        log: ["log", `-n${Math.min(Math.max(Number(args.limit) || 20, 1), 200)}`, "--date=short", "--pretty=format:%h %ad %an — %s", ...(rev ? [rev] : [])],
        show: ["show", "--stat", "--patch", rev || "HEAD"],
        blame: ["blame", "--date=short", "-w", ...(rev ? [rev] : [])],
        branch: ["branch", "--all", "-vv"],
      };
      const rest = argv[cmd];
      if (!rest) return { output: `git: unknown command "${cmd}"`, isError: true };
      if (cmd === "blame" && !path) return { output: "git blame needs a `path`.", isError: true };
      if (path && cmd !== "branch" && cmd !== "status") rest.push("--", path);
      else if (path && cmd === "status") rest.push("--", path);
      const res = spawnSync("git", rest, { encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024, cwd: process.cwd(), env: scrubbedEnv() });
      if (res.error) return { output: `git: ${res.error.message}`, isError: true };
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      return { output: spillIfHuge(out || "(no output)"), isError: res.status !== 0 };
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
      const pattern = String(args.pattern);
      const searchPath = String(args.path ?? ".");
      const root = resolve(process.cwd(), searchPath);
      if (!existsSync(root)) return { output: `Not found: ${searchPath}`, isError: true };
      const MAX = 200;
      // Fast path: ripgrep if available (much faster on big trees; respects .gitignore).
      const rg = findBin("rg");
      if (rg) {
        const rgArgs = ["--no-heading", "--line-number", "--color", "never"];
        if (args.ignore_case) rgArgs.push("-i");
        rgArgs.push("-e", pattern, searchPath);
        const r = spawnSync(rg, rgArgs, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000, env: scrubbedEnv() });
        if (r.status === 0 || r.status === 1) {
          // 0 = matches, 1 = no matches
          const out = (r.stdout || "").split("\n").filter(Boolean).slice(0, MAX);
          const more = out.length >= MAX ? `\n… (capped at ${MAX})` : "";
          return { output: (out.join("\n") || "(no matches)") + more };
        }
        // rg failed (e.g. its regex dialect rejected the pattern) → fall through to the JS scan
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern, args.ignore_case ? "i" : "");
      } catch (e) {
        return { output: `Invalid regex: ${e instanceof Error ? e.message : e}`, isError: true };
      }
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
    name: "codebase_search",
    description:
      "Semantic (meaning-based) search over the codebase — finds code by what it DOES, not by exact strings. Use when grep's literal matching won't work (\"where do we handle auth?\", \"how are sessions persisted?\"). First call indexes the repo locally (embeddings run in-process — no key or network beyond a one-time model download); later calls are incremental.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're looking for, in plain words." },
        k: { type: "number", description: "How many results (default 6)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      try {
        const { searchCodebase } = await import("./embed-index.ts"); // lazy — only pay for it when used
        const hits = await searchCodebase(String(args.query), Math.min(Number(args.k) || 6, 20));
        if (!hits.length) return { output: "No indexed content matched. Is the repo empty, or all files skipped?" };
        return { output: hits.map((h) => `${h.file}:${h.start}-${h.end}  (score ${h.score.toFixed(3)})\n${h.snippet}`).join("\n\n---\n\n") };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
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
    name: "ask_user",
    description: "Ask the user a clarifying question and wait for their answer. Use only when you're genuinely blocked or a decision is the user's to make — not for routine choices. Optionally provide a list of options.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
      required: ["question"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      if (!asker) return { output: "(no interactive session — cannot ask the user; proceed with your best judgment)", isError: true };
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : undefined;
      try {
        const answer = (await asker(String(args.question ?? ""), options)).trim();
        return { output: answer ? `User answered: ${answer}` : "(user gave no answer)" };
      } catch (e) {
        return { output: String(e), isError: true };
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
    name: "generate_pptx",
    lazy: true,
    description:
      "Render a real, editable .pptx. You supply finished content — 3-6 specific bullets per content slide (facts, numbers, names); " +
      "title-only decks are rejected. Subtitle without bullets = section slide. Add `notes` (speaker notes). For visuals prefer " +
      "`chart` (bar data) or `metrics` (up to 4 KPI tiles) — no file needed; use `image` for screenshots/diagrams (see generate_image). "+
      "When the user's wording doesn't pin the format - 'a presentation', 'a report', 'an overview' - ask_user first which they want: a .pptx (editable in PowerPoint, sends as a file) or an HTML page (opens in a browser, one file to share). Don't ask when they said deck/slides/pptx or page/one-pager. " +
      "End with a summary slide.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path ending in .pptx; a bare filename goes to docs/." },
        title: { type: "string", description: "Deck title." },
        slides: {
          type: "array",
          description: "Slides, in order.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtitle: { type: "string" },
              bullets: { type: "array", items: {}, description: 'Strings or {text, level} for sub-bullets.' },
              image: { type: "string", description: "Local png/jpg/gif to embed." },
              chart: {
                type: "object",
                description: "Bar chart drawn as native shapes.",
                properties: {
                  data: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"], additionalProperties: false } },
                  unit: { type: "string", description: 'Value suffix, e.g. "%".' },
                },
                required: ["data"],
                additionalProperties: false,
              },
              metrics: {
                type: "array",
                description: "Up to 4 KPI tiles (figure + caption).",
                items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value"], additionalProperties: false },
              },
              notes: { type: "string", description: "Speaker notes." },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["path", "slides"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      // Bare filename ⇒ keep decks out of the project root: default them into docs/.
      const given = String(args.path);
      const rel = /[\\/]/.test(given) ? given : join("docs", given);
      const abs = resolve(process.cwd(), rel);
      if (!abs.toLowerCase().endsWith(".pptx")) return { output: `generate_pptx: path must end in .pptx (got ${given})`, isError: true };
      return withFileLock(abs, async () => {
        if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
        checkpoint.record(abs);
        try {
          // Weak models often JSON-stringify the nested array — accept that too.
          let slides = args.slides;
          if (typeof slides === "string") {
            try {
              slides = JSON.parse(slides);
            } catch {
              /* leave as-is; buildPptx reports the clear error */
            }
          }
          args = { ...args, slides };
          // Guard against title-only decks: a slide with no bullets/subtitle/image is an empty shell.
          // Models routinely emit an outline and call it done — make that a hard error, not a bad deck.
          if (Array.isArray(slides)) {
            const empty = (slides as PptxSlideSpec[]).filter((s) => {
              const b = Array.isArray(s?.bullets) ? s.bullets.length : 0;
              return b === 0 && !s?.subtitle && !s?.image && !s?.chart && !s?.metrics;
            }).length;
            if (slides.length > 1 && empty > 1) {
              return {
                output:
                  `generate_pptx: refused — ${empty} of ${slides.length} slides have only a title (no bullets, subtitle, or image). ` +
                  "That produces an empty outline, not a deck. Re-send with real content: 3-6 substantive bullets per content slide " +
                  "(specific facts, numbers, names — not placeholders), `notes` for speaker notes, and `image` for any diagram or " +
                  "screenshot. Only the opening/section slides may use a subtitle with no bullets.",
                isError: true,
              };
            }
          }
          const buf = buildPptx({ title: args.title == null ? undefined : String(args.title), slides: slides as PptxSlideSpec[] });
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
          const n = (args.slides as unknown[]).length;
          // End with the ABSOLUTE path so the user can open the deck straight from the reply.
          return {
            output:
              `Wrote ${rel}: ${n} slide${n === 1 ? "" : "s"}, ${buf.length} bytes.\n` +
              `Open it here: ${abs}\n` +
              "Tell the user the deck is ready and end your reply with this full path on its own line.",
            display: green(`+ ${rel} (${n} slide${n === 1 ? "" : "s"}, ${buf.length} bytes)\n  ${abs}`),
          };
        } catch (e) {
          return { output: e instanceof Error ? e.message : String(e), isError: true };
        }
      });
    },
  },
  {
    name: "generate_docx",
    lazy: true,
    description:
      "Render a real, editable .docx. You supply finished prose. Block types: heading (1-3), paragraph, bullets (nestable), " +
      "numbered, table, chart, metrics, image, pageBreak. Headings-only documents are rejected — write real content. " +
      "Use tables for structured data, chart/metrics for visuals. A bare filename lands in docs/.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path ending in .docx; a bare filename goes to docs/." },
        title: { type: "string", description: "Document title." },
        subtitle: { type: "string", description: "Subtitle." },
        blocks: {
          type: "array",
          description: "Blocks, in order.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "bullets", "numbered", "table", "chart", "metrics", "image", "pageBreak"] },
              text: { type: "string", description: "heading/paragraph text." },
              level: { type: "number", description: "Heading level 1-3." },
              bold: { type: "boolean" },
              italic: { type: "boolean" },
              items: { type: "array", items: {}, description: "bullets/numbered items." },
              headers: { type: "array", items: { type: "string" }, description: "table header row." },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table body rows." },
              data: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"], additionalProperties: false }, description: "chart bars." },
              unit: { type: "string", description: 'chart value suffix.' },
              path: { type: "string", description: "image file path." },
              width: { type: "number", description: "image width in inches." },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "blocks"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const given = String(args.path);
      const rel = /[\\/]/.test(given) ? given : join("docs", given);
      const abs = resolve(process.cwd(), rel);
      if (!abs.toLowerCase().endsWith(".docx")) return { output: `generate_docx: path must end in .docx (got ${given})`, isError: true };
      return withFileLock(abs, async () => {
        if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
        checkpoint.record(abs);
        try {
          let blocks = args.blocks;
          if (typeof blocks === "string") {
            try {
              blocks = JSON.parse(blocks);
            } catch {
              /* leave as-is; buildDocx reports the clear error */
            }
          }
          // Same guard as decks: headings with no prose is an outline, not a document.
          if (Array.isArray(blocks)) {
            const substantive = (blocks as DocxBlock[]).filter((b) => b && b.type !== "heading" && b.type !== "pageBreak").length;
            if (blocks.length > 1 && substantive === 0) {
              return {
                output:
                  "generate_docx: refused — the document is only headings, with no paragraphs, lists, tables, or images. " +
                  "Re-send with real content under each heading.",
                isError: true,
              };
            }
          }
          const buf = buildDocx({
            title: args.title == null ? undefined : String(args.title),
            subtitle: args.subtitle == null ? undefined : String(args.subtitle),
            blocks: blocks as DocxBlock[],
          });
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
          const n = (blocks as unknown[]).length;
          return {
            output:
              `Wrote ${rel}: ${n} block${n === 1 ? "" : "s"}, ${buf.length} bytes.\n` +
              `Open it here: ${abs}\n` +
              "Tell the user the document is ready and end your reply with this full path on its own line.",
            display: green(`+ ${rel} (${n} block${n === 1 ? "" : "s"}, ${buf.length} bytes)\n  ${abs}`),
          };
        } catch (e) {
          return { output: e instanceof Error ? e.message : String(e), isError: true };
        }
      });
    },
  },
  {
    name: "generate_image",
    lazy: true,
    description:
      "Generate a PNG from a text prompt. Write a specific prompt (subject, style, composition). To illustrate a deck or document, create the PNG first, then pass its path as a slide `image` / image block.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image: subject, style, mood, lighting, composition." },
        path: { type: "string", description: "Output file path ending in .png." },
        size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"], description: "Dimensions: square (default), landscape, or portrait." },
      },
      required: ["prompt", "path"],
      additionalProperties: false,
    },
    needsApproval: true,
    async run(args) {
      const rel = String(args.path);
      const abs = resolve(process.cwd(), rel);
      if (!abs.toLowerCase().endsWith(".png")) return { output: `generate_image: path must end in .png (got ${rel})`, isError: true };
      return withFileLock(abs, async () => {
        if (isProtected(abs)) return { output: `Refused: ${rel} is a protected path.`, isError: true };
        try {
          const size = (args.size as string) ?? "1024x1024";
          let b64: string | undefined;
          if (process.env.OPENAI_API_KEY) {
            const { default: OpenAI } = await import("openai");
            const client = new OpenAI(); // direct to OpenAI when the user has their own key
            const res = await client.images.generate({ model: "gpt-image-1", prompt: String(args.prompt), size: size as "1024x1024" });
            b64 = res.data?.[0]?.b64_json;
          } else {
            // No local key (the normal case in the desktop app): go through the ada backend, which
            // holds the provider key. Keeps image generation working without any user setup.
            const base = process.env.ADA_BACKEND_URL ?? "http://localhost:8787/v1";
            const r = await fetch(`${base}/images/generations`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADA_CLIENT_KEY ?? "dev"}` },
              // No model here on purpose: the backend picks one for whichever image provider it has.
              body: JSON.stringify({ prompt: String(args.prompt), size }),
              signal: AbortSignal.timeout(180_000),
            });
            const text = await r.text();
            if (!r.ok) return { output: `generate_image: backend HTTP ${r.status}: ${text.slice(0, 200)}`, isError: true };
            b64 = (JSON.parse(text) as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
          }
          if (!b64) return { output: "generate_image: API returned no image data.", isError: true };
          checkpoint.record(abs);
          mkdirSync(dirname(abs), { recursive: true });
          const buf = Buffer.from(b64, "base64");
          writeFileSync(abs, buf);
          // Pop the viewer only in the interactive CLI. Under `serve` (the IDE) a deck with three
          // illustrations would otherwise fling three image windows at the user.
          if (process.stdout.isTTY) {
            const [cmd, cargs] =
              process.platform === "win32" ? ["cmd", ["/c", "start", "", abs]] : process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]];
            try {
              spawnSync(cmd as string, cargs as string[], { stdio: "ignore" });
            } catch {
              /* opening the viewer is best-effort */
            }
          }
          return {
            output:
              `Wrote ${rel} (${Math.round(buf.length / 1024)} KB).\nOpen it here: ${abs}\n` +
              "To use it in a deck or document, pass this path as a slide's `image` (generate_pptx) or an image block (generate_docx).",
            display: green(`+ ${rel} (${Math.round(buf.length / 1024)} KB image)\n  ${abs}`),
          };
        } catch (e) {
          return { output: e instanceof Error ? e.message : String(e), isError: true };
        }
      });
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
