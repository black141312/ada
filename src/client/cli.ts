// ada client REPL. Talks only to the ada backend.

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";
import { Agent, type AgentEvent, type ApprovalDecision, type OnApprove } from "./agent.ts";
import { ApprovalRegistry, newId, sseFrame } from "./agent-server.ts";
import { expandPrompt, loadPrompts } from "./prompts.ts";
import { Session, list, type SessionMeta } from "./session.ts";
import { deleteCredential, getCredential, listCredentials } from "../server/credentials.ts";
import { deviceLogin, oauthConfig } from "../server/oauth.ts";
import { addTrust, isTrusted, loadSettings, setActiveAgentPermissions, type Settings } from "./settings.ts";
import { getCommands, loadExtensions } from "./extensions.ts";
import { registerTool, setAsker } from "./tools.ts";
import { addRemoteSkill, loadSkills, registerSkillTool } from "./skills.ts";
import { addConnector, listConnectors, loadMcpServers, removeConnector } from "./mcp.ts";
import { addExtension, selfUpdate } from "./pkg.ts";
import { runTui } from "./tui-mode.ts";
import { loadImage } from "./image.ts";
import { notify, readClipboard, readClipboardImage } from "./platform.ts";
import { undoAll } from "./checkpoint.ts";
import { restore as restoreSnapshot, snapshot } from "./snapshot.ts";
import { catalogText, prefetch } from "./models-dev.ts";
import { ensureBackend } from "./autostart.ts";
import { renderJobs, startJob } from "./background.ts";
import { renderTodos } from "./todos.ts";
import { track } from "./telemetry.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type RL = ReturnType<typeof createInterface>;

const BACKEND = process.env.ADA_BACKEND_URL ?? "http://localhost:8787/v1";

/** A stored GitHub/Google login token, sent as the bearer so the backend can identify us. */
function identityToken(): string | undefined {
  for (const p of ["github", "google"]) {
    const c = getCredential(p);
    if (c?.type === "oauth" && c.access) return c.access;
  }
  return undefined;
}

function clientKey(): string {
  return process.env.ADA_CLIENT_KEY ?? identityToken() ?? "dev";
}

interface Flags {
  model?: string;
  listModels?: boolean;
  cont?: boolean;
  resume?: boolean;
  yolo?: boolean;
  print?: string;
  reasoning?: "low" | "medium" | "high";
  models?: string[];
  json?: boolean;
  rpc?: boolean;
  tui?: boolean;
  strategy?: string;
  agent?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

/** Render a session transcript as a self-contained HTML page (for `ada share`). */
function renderTranscript(title: string, messages: Array<{ role?: string; content?: unknown }>): string {
  const body = messages
    .map((m) => {
      const c = m.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "[image]").join("") : c == null ? "" : JSON.stringify(c);
      if (!text.trim()) return "";
      return `<div class="msg ${m.role ?? ""}"><div class="role">${escapeHtml(m.role ?? "")}</div><pre>${escapeHtml(text)}</pre></div>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · ada</title><style>
body{background:#0d0f12;color:#e6e9ee;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:820px;margin:0 auto;padding:32px}
h1{color:#ffaf00;font-size:18px}.msg{margin:16px 0;border-left:3px solid #262b33;padding-left:14px}
.msg.user{border-color:#ffaf00}.msg.assistant{border-color:#3fb950}.msg.tool{border-color:#82aaff}
.role{font:600 11px ui-monospace,monospace;color:#9aa3af;text-transform:uppercase;margin-bottom:4px}
pre{margin:0;white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;color:#c5cdd6}
</style></head><body><h1>◆ ${escapeHtml(title)}</h1>${body}</body></html>`;
}

/** Activate a named agent profile (prompt + permission rules) from settings. Returns false if unknown. */
function switchAgent(agent: Agent, name: string, settings: Settings): boolean {
  const profile = settings.agents?.[name];
  if (!profile) return false;
  setActiveAgentPermissions(profile.permissions ?? null);
  if (profile.prompt) agent.pushSystem(`You are now acting as the "${name}" agent. ${profile.prompt}`);
  return true;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") f.model = argv[++i];
    else if (a === "--list-models") f.listModels = true;
    else if (a === "--continue") f.cont = true;
    else if (a === "--resume") f.resume = true;
    else if (a === "--yolo") f.yolo = true;
    else if (a === "-p" || a === "--print") f.print = argv[++i] ?? "";
    else if (a === "--reasoning") {
      const v = argv[++i];
      if (v === "low" || v === "medium" || v === "high") f.reasoning = v;
    } else if (a === "--models") {
      f.models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--json") {
      f.json = true;
    } else if (a === "--rpc") {
      f.rpc = true;
    } else if (a === "--tui") {
      f.tui = true;
    } else if (a === "--strategy") {
      f.strategy = argv[++i];
    } else if (a === "--agent") {
      f.agent = argv[++i];
    }
  }
  return f;
}

function fuzzyPick(query: string, ids: string[]): string | null {
  const q = query.toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === q);
  if (exact) return exact;
  const subs = ids.filter((id) => id.toLowerCase().includes(q));
  if (subs.length) return subs.sort((a, b) => a.length - b.length)[0]!;
  return null;
}

async function fetchModelIds(client: OpenAI): Promise<string[]> {
  const ids: string[] = [];
  const res = await client.models.list();
  for await (const m of res) ids.push(m.id);
  return ids.sort();
}

function reportModelsError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Could not reach the ada backend at ${BACKEND}: ${msg}`);
  console.error("Is the backend running? Start it in another terminal:  npm run server");
}

async function printModels(client: OpenAI): Promise<void> {
  try {
    const ids = await fetchModelIds(client);
    console.log(ids.join("\n"));
    console.log(`\n${ids.length} models`);
  } catch (e) {
    reportModelsError(e);
  }
}

async function pickModel(client: OpenAI, rl: RL): Promise<string> {
  console.log("Fetching available models…");
  let ids: string[] = [];
  try {
    ids = await fetchModelIds(client);
  } catch (e) {
    reportModelsError(e);
  }
  if (!ids.length) return (await rl.question("Enter a model id: ")).trim();
  const shown = ids.slice(0, 40);
  if (stdin.isTTY) {
    const choice = await select(rl, "Select a model  (↑/↓ · Enter · Esc to type an id):", shown);
    if (choice !== null) return shown[choice]!;
  }
  shown.forEach((id, i) => console.log(`${String(i + 1).padStart(2)}. ${id}`));
  if (ids.length > 40) console.log(`… and ${ids.length - 40} more (type an id directly)`);
  const a = (await rl.question("pick # or type a model id: ")).trim();
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= ids.length) return ids[n - 1]!;
  return fuzzyPick(a, ids) ?? a;
}

async function pickSession(rl: RL): Promise<string | null> {
  const metas = list();
  if (!metas.length) {
    console.log("No saved sessions.");
    return null;
  }
  const top = metas.slice(0, 20);
  if (stdin.isTTY) {
    const choice = await select(rl, "Resume which session?  (↑/↓ · Enter · Esc to cancel):", top.map((m) => m.title));
    if (choice !== null) return top[choice]?.file ?? null;
    return null;
  }
  top.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. ${m.title}`));
  const a = (await rl.question("resume #: ")).trim();
  const idx = Number(a) - 1;
  return top[idx]?.file ?? null;
}

function rawOn(rl: RL, onData: (b: Buffer) => void): void {
  rl.pause();
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onData);
  stdin.resume();
}

function rawOff(rl: RL, onData: (b: Buffer) => void): void {
  stdin.off("data", onData);
  if (stdin.isTTY) stdin.setRawMode(false);
  rl.resume();
}

/** Decode a raw stdin chunk to a logical key: arrows (or j/k/Tab), enter, esc, ctrl-c, or the literal char. */
function decodeKey(s: string): string {
  if (s === "\x1b[A" || s === "k") return "up";
  if (s === "\x1b[B" || s === "j" || s === "\t") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "\x03") return "ctrl-c";
  if (s === "\x1b") return "esc";
  return s;
}

/**
 * Read decoded keypresses in raw mode until a handler calls done(). Two robustness points the
 * naive version got wrong: (1) a bare ESC may be the head of a split "\x1b[A" arrow sequence on
 * Windows/slow ptys, so it's held ~50ms and re-joined with the next chunk before being treated as
 * Esc; (2) teardown (listener removal + raw-mode restore + rl.resume) is guaranteed exactly once.
 */
function readKeys(rl: RL, onKey: (key: string, done: () => void) => void): void {
  let settled = false;
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  const done = (): void => {
    if (settled) return;
    settled = true;
    if (escTimer) clearTimeout(escTimer);
    stdin.off("data", handler);
    if (stdin.isTTY) stdin.setRawMode(false);
    rl.resume();
  };
  const emit = (s: string): void => onKey(decodeKey(s), done);
  const handler = (buf: Buffer): void => {
    let s = buf.toString("utf8");
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
      s = `\x1b${s}`; // re-join the ESC we were holding with this follow-up chunk (arrow keys)
    }
    if (s === "\x1b") {
      escTimer = setTimeout(() => {
        escTimer = null;
        emit("\x1b");
      }, 50);
      return;
    }
    emit(s);
  };
  rl.pause();
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", handler);
  stdin.resume();
}

/** Arrow-key list selector. Returns the chosen index, or null on Esc / non-TTY (caller falls back). */
async function select(rl: RL, title: string, items: string[]): Promise<number | null> {
  if (!stdin.isTTY || !items.length) return null;
  let idx = 0;
  const draw = (first: boolean): void => {
    if (!first) stdout.write(`\x1b[${items.length}A`); // jump back up to redraw in place
    for (let i = 0; i < items.length; i++) {
      stdout.write(i === idx ? `\x1b[2K\x1b[38;5;214m❯ ${items[i]}\x1b[0m\n` : `\x1b[2K  ${items[i]}\n`);
    }
  };
  stdout.write(`${title}\n`);
  draw(true);
  return await new Promise<number | null>((res) => {
    readKeys(rl, (key, done) => {
      if (key === "up") {
        idx = (idx - 1 + items.length) % items.length;
        draw(false);
      } else if (key === "down") {
        idx = (idx + 1) % items.length;
        draw(false);
      } else if (key === "enter") {
        done();
        res(idx);
      } else if (key === "esc" || key === "ctrl-c") {
        done();
        res(null);
      }
    });
  });
}

type PermMode = "ask" | "plan" | "auto";
type ApproveChoice = "yes" | "auto" | "plan" | "no";

/**
 * Tool-approval prompt. A fixed single-key prompt (no scrolling redraw — that fought the streaming
 * transcript and glitched): it states in plain words what permission is being requested + the actual
 * target, then reads one key — [y]es · [a]uto (run the rest without asking) · [p]lan (switch to plan
 * mode, skip this) · [n]o/Esc. `summary` is "<permission phrase>\n<detail>" from the agent.
 */
async function approvePrompt(rl: RL, name: string, summary: string): Promise<ApproveChoice> {
  const nl = summary.indexOf("\n");
  const risk = (nl >= 0 ? summary.slice(0, nl) : summary) || `run the ${name} tool`;
  const detail = nl >= 0 ? summary.slice(nl + 1).trim() : "";
  const danger = risk.startsWith("⚠");
  if (!stdin.isTTY) {
    const ans = (await rl.question(`\x1b[33m? ${risk}  [y]es / [a]uto / [p]lan / [N]o \x1b[0m`)).trim().toLowerCase();
    return ans[0] === "y" ? "yes" : ans[0] === "a" ? "auto" : ans[0] === "p" ? "plan" : "no";
  }
  const cols = (stdout.columns || 80) - 2;
  const head = `${danger ? "\x1b[31m" : "\x1b[33m"}ada wants to ${risk.replace(/^⚠ /, "")}\x1b[0m`;
  const det = detail ? `  \x1b[2m${detail.length > cols ? `${detail.slice(0, cols - 1)}…` : detail}\x1b[0m\n` : "";
  stdout.write(`\n${danger ? "\x1b[31m⚠\x1b[0m " : ""}${head}\n${det}\x1b[2m[\x1b[0my\x1b[2m]es  [\x1b[0ma\x1b[2m]uto  [\x1b[0mp\x1b[2m]lan  [\x1b[0mn\x1b[2m]o ›\x1b[0m `);
  return await new Promise<ApproveChoice>((res) => {
    readKeys(rl, (key, done) => {
      const k = key.length === 1 ? key.toLowerCase() : key;
      const val: ApproveChoice | null = k === "y" || key === "enter" ? "yes" : k === "a" ? "auto" : k === "p" ? "plan" : k === "n" || key === "esc" || key === "ctrl-c" ? "no" : null;
      if (!val) return;
      done();
      stdout.write(`\r\x1b[2K${val === "no" ? "\x1b[31m✗\x1b[0m skipped" : `\x1b[32m✓\x1b[0m ${val === "auto" ? "auto (won't ask again)" : val === "plan" ? "→ plan mode" : "ran"}`}\n`);
      res(val);
    });
  });
}

function printTree(currentFile: string): void {
  const metas = list();
  if (!metas.length) {
    console.log("No sessions.");
    return;
  }
  const children = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    if (m.parent) {
      const arr = children.get(m.parent) ?? [];
      arr.push(m);
      children.set(m.parent, arr);
    }
  }
  const rec = (m: SessionMeta, depth: number): void => {
    const mark = m.file === currentFile ? "\x1b[38;5;214m●\x1b[0m" : "○";
    console.log(`${"  ".repeat(depth)}${mark} ${basename(m.file)}  \x1b[2m${m.title}\x1b[0m`);
    for (const c of children.get(m.file) ?? []) rec(c, depth + 1);
  };
  for (const m of metas.filter((x) => !x.parent || !metas.some((y) => y.file === x.parent))) rec(m, 0);
}

function makeClient(): OpenAI {
  return new OpenAI({ baseURL: BACKEND, apiKey: clientKey(), maxRetries: 0 });
}

/** Run the device flow for `provider`; returns true on success (token stored). */
async function loginFlow(provider: string): Promise<boolean> {
  const cfg = oauthConfig(provider);
  if (!cfg) {
    console.log(`No OAuth config for ${provider}. Set ADA_OAUTH_${provider.toUpperCase()}_{CLIENT_ID,DEVICE_URL,TOKEN_URL}.`);
    return false;
  }
  try {
    await deviceLogin(provider, cfg, (s) => console.log(s));
    return true;
  } catch (e) {
    console.error(`login failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Startup login check: probe the backend; if it says 401, offer to sign in and rebuild the client. */
async function ensureAuth(rl: RL, client: OpenAI): Promise<OpenAI> {
  let status: number;
  try {
    const r = await fetch(`${BACKEND}/whoami`, { headers: { authorization: `Bearer ${clientKey()}` } });
    status = r.status;
  } catch {
    return client; // backend unreachable — the model fetch will report it
  }
  if (status !== 401) return client; // 200 = already authorized, or backend is open (dev)
  const provider = ["github", "google"].find((p) => oauthConfig(p));
  if (!provider) {
    console.log("\x1b[33mthis backend requires login, but no OAuth provider is configured (set ADA_OAUTH_*).\x1b[0m");
    return client;
  }
  const ans = (await rl.question(`\x1b[33mnot logged in — sign in with ${provider}? [Y/n] \x1b[0m`)).trim().toLowerCase();
  if (ans === "n" || ans === "no") return client;
  return (await loginFlow(provider)) ? makeClient() : client;
}

async function authCommand(sub: string, provider?: string): Promise<void> {
  if (!provider) {
    console.error(`usage: ada ${sub} <provider>`);
    console.log(listCredentials().length ? `logged in: ${listCredentials().join(", ")}` : "no stored credentials");
    process.exit(1);
  }
  if (sub === "logout") {
    await deleteCredential(provider);
    console.log(`logged out ${provider}`);
    return;
  }
  if (!(await loginFlow(provider))) process.exit(1);
}

/** Gate project-level files (.ada/prompts, AGENTS.md, project settings) behind explicit trust. */
async function ensureTrust(rl: RL): Promise<boolean> {
  const cwd = process.cwd();
  if (isTrusted(cwd)) return true;
  if (!stdin.isTTY) return false; // headless: never load untrusted project files
  const ans = (await rl.question(`Trust ${cwd} and load its .ada config (prompts, AGENTS.md, settings)? [y/N] `)).trim().toLowerCase();
  if (ans === "y" || ans === "yes") {
    addTrust(cwd);
    return true;
  }
  return false;
}

// ANSI-Shadow "ada", rendered as a truecolor splash. █ = gradient body, box glyphs = drop shadow.
const ADA_ART = [
  " █████╗ ██████╗  █████╗ ",
  "██╔══██╗██╔══██╗██╔══██╗",
  "███████║██║  ██║███████║",
  "██╔══██║██║  ██║██╔══██║",
  "██║  ██║██████╔╝██║  ██║",
  "╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝",
];
const GRADIENT: [number, number, number][] = [
  [255, 214, 92], // gold
  [255, 122, 41], // orange
  [214, 51, 132], // magenta
];

/** Interpolate the gradient stops at t∈[0,1]. */
function gradientAt(t: number): [number, number, number] {
  const seg = Math.max(0, Math.min(1, t)) * (GRADIENT.length - 1);
  const i = Math.min(Math.floor(seg), GRADIENT.length - 2);
  const f = seg - i;
  const [a, b] = [GRADIENT[i]!, GRADIENT[i + 1]!];
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as [number, number, number];
}

function adaVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const TAG = "a coding agent from zero";
const W = Math.max(...ADA_ART.map((l) => l.length));
const H = ADA_ART.length;
const EDGE = 6; // width of the bright leading edge of the light sweep

/** One logo row at light-sweep position `sweep`. Unlit ahead of the edge, white-hot at it, settled gradient behind. */
function logoRow(line: string, y: number, sweep: number): string {
  let s = "\x1b[2K  "; // clear line, then indent
  [...line].forEach((ch, x) => {
    if (ch === " ") return void (s += " ");
    if (ch !== "█") return void (s += `\x1b[0m\x1b[38;2;92;72;82m${ch}`); // outline = drop shadow
    if (x > sweep) return void (s += `\x1b[0m\x1b[38;2;70;55;62m█`); // not yet lit
    const [r, g, b] = gradientAt((x / W + y / H) / 2);
    const d = sweep - x;
    if (d < EDGE) {
      const t = 1 - d / EDGE; // 1 at the edge, fading to 0 as it settles
      const mix = (c: number): number => Math.round(c + (255 - c) * t * 0.85);
      return void (s += `\x1b[1m\x1b[38;2;${mix(r)};${mix(g)};${mix(b)}m█`);
    }
    return void (s += `\x1b[1m\x1b[38;2;${r};${g};${b}m█`);
  });
  return s + "\x1b[0m";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Startup splash: a ~400ms left-to-right light sweep over the logo on a TTY; static plain text otherwise. */
async function printBanner(): Promise<void> {
  const fancy = stdout.isTTY === true && process.env.NO_COLOR === undefined;
  if (!fancy) {
    const body = ADA_ART.map((l) => `  ${l}`).join("\n");
    stdout.write(`\n${body}\n  ${TAG}  v${adaVersion()}\n\n`);
    return;
  }
  const frames = 18;
  stdout.write("\x1b[?25l\n"); // hide cursor, leading blank line
  try {
    for (let f = 0; f <= frames; f++) {
      const sweep = (f / frames) * (W + EDGE);
      if (f > 0) stdout.write(`\x1b[${H}A`); // jump back up to redraw in place
      stdout.write(`${ADA_ART.map((line, y) => logoRow(line, y, sweep)).join("\n")}\n`);
      if (f < frames) await sleep(400 / frames);
    }
  } finally {
    stdout.write("\x1b[?25h"); // always restore the cursor, even if interrupted
  }
  stdout.write(`  \x1b[2m${TAG}\x1b[0m  \x1b[38;2;214;51;132mv${adaVersion()}\x1b[0m\n\n`);
}

/** Subcommands that don't touch the backend — no point spawning a server for these. */
const NO_BACKEND = new Set(["mcp", "skill", "worktree", "wt", "catalog", "share"]);

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "login" || sub === "logout") {
    await authCommand(sub, process.argv[3]);
    return;
  }
  // Auto-start ada-server if the configured backend isn't reachable (and it's local). New users
  // shouldn't have to run two terminals; `ADA_BACKEND_URL` pointing at a remote skips this.
  if (!NO_BACKEND.has(sub ?? "") && process.env.ADA_NO_AUTOSTART !== "1") {
    const status = await ensureBackend(BACKEND);
    if (status === "failed") {
      console.error("ada-server failed to come up. Start it manually: `ada-server` (in another terminal).");
      process.exit(1);
    }
  }
  if (sub === "add") {
    const spec = process.argv[3];
    if (!spec) {
      console.error("usage: ada add <git-url | npm-package>");
      process.exit(1);
    }
    try {
      addExtension(spec);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    return;
  }
  if (sub === "update") {
    selfUpdate();
    return;
  }
  if (sub === "mcp") {
    const action = process.argv[3] ?? "list";
    const name = process.argv[4];
    if (action === "list" || action === "ls") {
      console.log("Connector catalog (● configured · ○ available):\n");
      for (const c of listConnectors()) {
        const dot = c.configured ? "\x1b[38;5;214m●\x1b[0m" : "○";
        const env = c.needsEnv.length ? `  \x1b[2m(set: ${c.needsEnv.join(", ")})\x1b[0m` : "";
        console.log(`  ${dot} ${c.name.padEnd(14)} ${c.description}${env}`);
      }
      console.log("\n  ada mcp add <name>   ·   ada mcp remove <name>");
      console.log("  custom server: edit .ada/mcp.json — a { command,args } (stdio) or { url } (http) entry");
      return;
    }
    if (action === "add") {
      if (!name) {
        console.error("usage: ada mcp add <name>");
        process.exit(1);
      }
      const r = addConnector(name);
      if (!r.ok) {
        console.error(r.error);
        process.exit(1);
      }
      console.log(`\x1b[38;5;214m✓\x1b[0m added "${name}" to .ada/mcp.json`);
      if (r.envVars.length) console.log(`  set before use: ${r.envVars.join(", ")}`);
      return;
    }
    if (action === "remove" || action === "rm") {
      if (!name) {
        console.error("usage: ada mcp remove <name>");
        process.exit(1);
      }
      console.log(removeConnector(name) ? `removed "${name}" from .ada/mcp.json` : `"${name}" was not configured`);
      return;
    }
    console.error("usage: ada mcp [list | add <name> | remove <name>]");
    process.exit(1);
  }
  if (sub === "worktree" || sub === "wt") {
    const action = process.argv[3] ?? "list";
    const git = (...a: string[]): { status: number | null; out: string } => {
      const r = spawnSync("git", a, { encoding: "utf8", cwd: process.cwd() });
      return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
    };
    if (action === "list" || action === "ls") {
      const r = git("worktree", "list");
      console.log(r.status === 0 ? r.out : "(not a git repo or no worktrees)");
      return;
    }
    if (action === "add" || action === "new") {
      const name = process.argv[4];
      if (!name) {
        console.error("usage: ada worktree add <name>");
        process.exit(1);
      }
      const branch = `ada/${name}`;
      const dir = resolve(process.cwd(), "..", `${basename(process.cwd())}-${name}`);
      const r = git("worktree", "add", "-b", branch, dir);
      if (r.status !== 0) {
        console.error(r.out || "git worktree add failed");
        process.exit(1);
      }
      console.log(`\x1b[38;5;214m✓\x1b[0m worktree ${dir}\n  branch ${branch} — cd "${dir}" && ada`);
      return;
    }
    if (action === "remove" || action === "rm") {
      const name = process.argv[4];
      if (!name) {
        console.error("usage: ada worktree remove <name>");
        process.exit(1);
      }
      const dir = resolve(process.cwd(), "..", `${basename(process.cwd())}-${name}`);
      const r = git("worktree", "remove", dir);
      console.log(r.status === 0 ? `removed ${dir}` : r.out);
      return;
    }
    console.error("usage: ada worktree [list | add <name> | remove <name>]");
    process.exit(1);
  }
  if (sub === "skill") {
    const action = process.argv[3] ?? "list";
    if (action === "add") {
      const url = process.argv[4];
      if (!url) {
        console.error("usage: ada skill add <url>   (a SKILL.md, or a JSON index of them)");
        process.exit(1);
      }
      try {
        const added = await addRemoteSkill(url);
        console.log(added.length ? `\x1b[38;5;214m✓\x1b[0m installed: ${added.join(", ")} → ~/.ada/skills/` : "no skills found at that URL");
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
      }
      return;
    }
    if (action === "list" || action === "ls") {
      for (const s of loadSkills(true)) console.log(`  ${s.name.padEnd(22)} ${s.description}`);
      return;
    }
    console.error("usage: ada skill [list | add <url>]");
    process.exit(1);
  }
  if (sub === "catalog") {
    // Offline model catalog (curated popular providers) — context limits + pricing, no backend/network.
    console.log(catalogText(process.argv[3]));
    return;
  }
  if (sub === "acp") {
    // Minimal Agent Client Protocol bridge over stdio (JSON-RPC 2.0, newline-delimited). Scaffold:
    // handles initialize + prompt so an ACP-aware editor can drive ada. Extend method names/framing
    // to match your client's ACP version.
    const trusted = isTrusted(process.cwd());
    const settings = loadSettings(trusted);
    await loadExtensions(trusted);
    registerSkillTool(loadSkills(trusted));
    await loadMcpServers(trusted);
    const client = makeClient();
    let model = process.env.ADA_MODEL || settings.model || "";
    if (!model) {
      try {
        model = (await fetchModelIds(client))[0] ?? "";
      } catch {
        /* offline */
      }
    }
    const agent = new Agent({ client, model, session: Session.create(), onApprove: async (): Promise<ApprovalDecision> => "yes", autoApprove: true, project: trusted, compactAt: settings.compactAt });
    const send = (msg: object): void => void stdout.write(`${JSON.stringify(msg)}\n`);
    let buf = "";
    stdin.on("data", async (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } } });
        else if (msg.method === "session/new" || msg.method === "newSession") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ada" } });
        else if (msg.method === "session/prompt" || msg.method === "prompt") {
          const p = msg.params ?? {};
          const blocks = (p.prompt ?? p.text) as unknown;
          const text = Array.isArray(blocks) ? blocks.map((b) => (b as { text?: string }).text ?? "").join("") : String(blocks ?? "");
          try {
            const out = await agent.send(text, { quiet: true });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", content: [{ type: "text", text: out }] } });
          } catch (e) {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
          }
        } else if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    });
    await new Promise(() => {});
    return;
  }
  if (sub === "share") {
    const arg = process.argv[3];
    const metas = list();
    const meta = arg ? metas.find((m) => m.file.includes(arg) || m.title.toLowerCase().includes(arg.toLowerCase())) : metas[0];
    if (!meta) {
      console.error(arg ? `no session matching "${arg}"` : "no sessions yet");
      process.exit(1);
    }
    const messages = Session.open(meta.file).load() as Array<{ role?: string; content?: unknown }>;
    const html = renderTranscript(meta.title, messages);
    const port = Number(process.env.ADA_SHARE_PORT) || 8790;
    const { createServer } = await import("node:http");
    createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html)).listen(port, () =>
      console.log(`\x1b[38;5;214m◆\x1b[0m session "${meta.title}" → http://localhost:${port}  (local, read-only — Ctrl+C to stop)`),
    );
    await new Promise(() => {});
    return;
  }
  if (sub === "serve") {
    const trusted = isTrusted(process.cwd());
    const settings = loadSettings(trusted);
    await loadExtensions(trusted);
    registerSkillTool(loadSkills(trusted));
    await loadMcpServers(trusted);
    const client = makeClient();
    let model = (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "") || process.env.ADA_MODEL || settings.model || "";
    if (!model) {
      try {
        model = (await fetchModelIds(client))[0] ?? "";
      } catch {
        /* offline */
      }
    }
    const port = Number(process.env.ADA_HTTP_PORT) || 8788;

    // Interactive sessions — for driving ada like an IDE agent panel (live text/tool-call events,
    // and edits pause for YOUR approval UI instead of auto-running). See docs/integrations.md.
    interface AgentSession {
      agent: Agent;
      registry: ApprovalRegistry;
      emit: ((frame: string) => void) | null; // set only while a /prompt request's SSE stream is open
      file: string; // the on-disk transcript — survives an `ada serve` restart; resume with it
    }
    const sessions = new Map<string, AgentSession>();
    // `resumeFile` reattaches to an existing on-disk transcript (e.g. after `ada serve` restarted) —
    // its history replays into the new in-memory Agent so the conversation picks up where it left off.
    const makeSession = (m: string, resumeFile?: string): { id: string; rec: AgentSession } => {
      const session = resumeFile ? Session.open(resumeFile) : Session.create();
      const history = resumeFile ? (session.load() as unknown as Msg[]) : undefined;
      const rec: AgentSession = { agent: undefined as unknown as Agent, registry: new ApprovalRegistry(), emit: null, file: session.file };
      rec.agent = new Agent({
        client,
        model: m,
        session,
        history,
        project: trusted,
        compactAt: settings.compactAt,
        autoApprove: false,
        onApprove: async (toolName, summary): Promise<ApprovalDecision> => {
          if (!rec.emit) return "no"; // no open stream to ask through — fail closed, don't silently run
          const { id, promise } = rec.registry.wait();
          rec.emit(sseFrame({ type: "approval_request", id, name: toolName, summary }));
          return promise;
        },
      });
      const id = newId("sess");
      sessions.set(id, rec);
      return { id, rec };
    };

    const { createServer } = await import("node:http");
    createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, model, sessions: sessions.size }));
        return;
      }
      // One-shot, no memory between calls — good for a "generate this" action, not a chat panel.
      if (req.method === "POST" && url.pathname === "/v1/prompt") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const j = JSON.parse(body || "{}") as { text?: string; model?: string };
            const agent = new Agent({ client, model: j.model || model, session: Session.create(), onApprove: async (): Promise<ApprovalDecision> => "yes", autoApprove: true, project: trusted, compactAt: settings.compactAt });
            const text = await agent.send(String(j.text ?? ""), { quiet: true });
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text, usage: agent.usageReport() }));
          } catch (e) {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        });
        return;
      }
      // Interactive: persistent session, streamed events, approval round-trip.
      // List on-disk transcripts (survive an `ada serve` restart) so an IDE can offer "resume".
      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: list() }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let m = model;
          let resume: string | undefined;
          try {
            const j = JSON.parse(body || "{}") as { model?: string; resume?: string };
            m = j.model || model;
            // "latest" picks the most recently modified transcript; otherwise resume expects one of
            // the `file` values from GET /v1/sessions (a restarted `ada serve` has no memory of which
            // in-memory sessionIds existed before, so the IDE re-resolves by transcript file instead).
            if (j.resume === "latest") resume = list()[0]?.file;
            else if (j.resume && list().some((s) => s.file === j.resume)) resume = j.resume;
          } catch {
            /* ignore, use default model + no resume */
          }
          const { id, rec } = makeSession(m, resume);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: id, model: m, file: rec.file, resumed: !!resume }));
        });
        return;
      }
      const promptMatch = req.method === "POST" && url.pathname.match(/^\/v1\/sessions\/([^/]+)\/prompt$/);
      if (promptMatch) {
        const rec = sessions.get(promptMatch[1]!);
        if (!rec) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          let text = "";
          try {
            text = String((JSON.parse(body || "{}") as { text?: string }).text ?? "");
          } catch {
            /* empty prompt */
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          rec.emit = (frame) => res.write(frame);
          try {
            await rec.agent.send(text, { onEvent: (e: AgentEvent) => res.write(sseFrame(e)) });
          } catch (e) {
            res.write(sseFrame({ type: "error", message: e instanceof Error ? e.message : String(e) }));
          } finally {
            rec.emit = null;
            res.end();
          }
        });
        return;
      }
      const approveMatch = req.method === "POST" && url.pathname.match(/^\/v1\/sessions\/([^/]+)\/approve$/);
      if (approveMatch) {
        const rec = sessions.get(approveMatch[1]!);
        if (!rec) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let ok = false;
          try {
            const { id, decision } = JSON.parse(body || "{}") as { id?: string; decision?: ApprovalDecision };
            if (id && decision) ok = rec.registry.settle(id, decision);
          } catch {
            /* ok stays false */
          }
          res.writeHead(ok ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ ok }));
        });
        return;
      }
      const delMatch = req.method === "DELETE" && url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (delMatch) {
        const existed = sessions.delete(delMatch[1]!);
        res.writeHead(existed ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ ok: existed }));
        return;
      }
      res.writeHead(404).end();
    }).listen(port, () =>
      console.log(
        `ada HTTP API on http://localhost:${port}  ·  model ${model || "(none — set one)"}\n` +
          `  one-shot:    POST /v1/prompt {"text":"…"}\n` +
          `  interactive: POST /v1/sessions → {sessionId}\n` +
          `               POST /v1/sessions/:id/prompt {"text":"…"}  (SSE: text/tool_call/tool_result/approval_request/done)\n` +
          `               POST /v1/sessions/:id/approve {"id":"…","decision":"yes"|"all"|"no"}`,
      ),
    );
    await new Promise(() => {}); // keep the process alive for the server
    return;
  }
  const flags = parseArgs(process.argv.slice(2));
  void prefetch(); // warm the models.dev catalog (pricing/limits) in the background
  let client = makeClient();

  if (flags.listModels) {
    await printModels(client);
    return;
  }

  const scoped = flags.models ?? [];

  // Headless RPC mode: newline-delimited JSON over stdio. One {"type":"prompt","text":…} per line in.
  if (flags.rpc) {
    const trusted = isTrusted(process.cwd());
    const settings = loadSettings(trusted);
    let rm = flags.model ?? process.env.ADA_MODEL ?? settings.model ?? scoped[0] ?? "";
    if (!rm) {
      try {
        rm = (await fetchModelIds(client))[0] ?? "";
      } catch {
        /* ignore */
      }
    }
    if (!rm) {
      process.stdout.write(`${JSON.stringify({ type: "error", error: "no model available" })}\n`);
      process.exit(1);
    }
    await loadExtensions(trusted);
    registerSkillTool(loadSkills(trusted));
    await loadMcpServers(trusted);
    const agent = new Agent({
      client,
      model: rm,
      session: Session.create(),
      onApprove: async (): Promise<ApprovalDecision> => "yes",
      autoApprove: true,
      reasoning: flags.reasoning ?? settings.reasoning,
      project: trusted,
      compactAt: settings.compactAt,
    });
    process.stdout.write(`${JSON.stringify({ type: "ready", model: rm })}\n`);
    for await (const line of createInterface({ input: stdin })) {
      const t = line.trim();
      if (!t) continue;
      let prompt = t;
      try {
        const obj = JSON.parse(t) as { text?: string; prompt?: string };
        prompt = obj.text ?? obj.prompt ?? "";
      } catch {
        /* treat the raw line as the prompt */
      }
      if (!prompt) continue;
      try {
        const text = await agent.send(prompt, { quiet: true });
        process.stdout.write(`${JSON.stringify({ type: "result", text, usage: agent.usageReport() })}\n`);
      } catch (e) {
        process.stdout.write(`${JSON.stringify({ type: "error", error: e instanceof Error ? e.message : String(e) })}\n`);
      }
    }
    return;
  }

  // Headless print mode: run one prompt non-interactively and exit.
  if (flags.print !== undefined) {
    const trusted = isTrusted(process.cwd());
    const settings = loadSettings(trusted);
    let pm = flags.model ?? process.env.ADA_MODEL ?? settings.model ?? scoped[0] ?? "";
    if (!pm) {
      try {
        pm = (await fetchModelIds(client))[0] ?? "";
      } catch {
        /* ignore */
      }
    }
    if (!pm) {
      console.error("No model available. Pass --model <id> or set ADA_MODEL.");
      process.exit(1);
    }
    const agent = new Agent({
      client,
      model: pm,
      session: Session.create(),
      onApprove: async (): Promise<ApprovalDecision> => "yes",
      autoApprove: true,
      reasoning: flags.reasoning ?? settings.reasoning,
      project: trusted,
      compactAt: settings.compactAt,
    });
    if (flags.strategy) agent.setStrategy(flags.strategy);
    const text = await agent.send(flags.print, { quiet: !!flags.json });
    if (flags.json) console.log(JSON.stringify({ model: pm, text, usage: agent.usageReport() }));
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  await printBanner();
  // While a turn runs we listen for raw keys (interrupt/steer); onApprove pauses this to read a line.
  let turn: { onData: (b: Buffer) => void } | null = null;

  const includeProject = await ensureTrust(rl);
  const settings = loadSettings(includeProject);
  const prompts = loadPrompts(includeProject);
  const kbInterrupt = settings.keybindings?.interrupt;
  const exts = await loadExtensions(includeProject);
  const skills = loadSkills(includeProject);
  registerSkillTool(skills);
  const mcp = await loadMcpServers(includeProject);

  client = await ensureAuth(rl, client); // always check login at startup; prompt if the backend says 401

  let session: Session;
  let history: Msg[] = [];
  if (flags.cont) {
    const s = Session.latest();
    if (s) {
      session = s;
      history = s.load() as unknown as Msg[];
      console.log(`Resuming ${s.file} (${history.length} messages)`);
    } else {
      console.log("No session to continue; starting fresh.");
      session = Session.create();
    }
  } else if (flags.resume) {
    const file = await pickSession(rl);
    if (file) {
      session = Session.open(file);
      history = session.load() as unknown as Msg[];
      console.log(`Resuming (${history.length} messages)`);
    } else {
      session = Session.create();
    }
  } else {
    session = Session.create();
  }

  let model = flags.model ?? process.env.ADA_MODEL ?? settings.model ?? scoped[0] ?? "";
  if (!model) {
    model = await pickModel(client, rl);
    if (!model) {
      rl.close();
      return;
    }
  }

  const autoApprove = !!flags.yolo || process.env.ADA_AUTO_APPROVE === "1" || !!settings.autoApprove;
  // Permission mode: ask = confirm each tool, plan = read-only (plan, don't run), auto = run freely.
  let mode = "ask" as PermMode; // `as` keeps the CFA type PermMode (it's mutated via setMode, a closure)
  let setMode = (_m: PermMode): void => {}; // reassigned once `agent` exists
  const onApprove: OnApprove = async (name, summary): Promise<ApprovalDecision> => {
    if (mode === "auto") return "yes";
    if (turn && stdin.isTTY) rawOff(rl, turn.onData); // detach the turn's raw key listener first
    try {
      const choice = await approvePrompt(rl, name, summary);
      if (choice === "auto") {
        setMode("auto");
        return "all";
      }
      if (choice === "plan") {
        setMode("plan");
        return "no";
      }
      return choice; // "yes" | "no"
    } finally {
      if (turn && stdin.isTTY) rawOn(rl, turn.onData);
    }
  };

  setAsker(async (question, options) => {
    if (turn && stdin.isTTY) rawOff(rl, turn.onData);
    try {
      // Multiple-choice → arrow-key selector; free-text → a plain line.
      if (options?.length && stdin.isTTY) {
        const i = await select(rl, `\x1b[36m? ${question}\x1b[0m`, options);
        return i == null ? "" : options[i]!;
      }
      let prompt = `\x1b[36m? ${question}\x1b[0m`;
      if (options?.length) prompt += `\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n› `;
      else prompt += " ";
      const ans = (await rl.question(prompt)).trim();
      if (options?.length) {
        const n = Number(ans);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
      }
      return ans;
    } finally {
      if (turn && stdin.isTTY) rawOn(rl, turn.onData);
    }
  });

  // Subagent: delegate an isolated subtask to a fresh ada agent (registered before the agent
  // snapshots its tool list, so it appears in the registry).
  registerTool({
    name: "spawn_agent",
    description: "Delegate a self-contained subtask to a fresh ada sub-agent; returns its final summary. Use for isolated research or a chunk of work handled independently.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The subtask, with all the context the sub-agent needs." } },
      required: ["task"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const sub = new Agent({
        client,
        model,
        session: Session.create(),
        onApprove,
        autoApprove,
        reasoning: flags.reasoning ?? settings.reasoning,
        project: includeProject,
        compactAt: settings.compactAt,
      });
      try {
        const text = await sub.send(String(args.task ?? ""), { quiet: true });
        return { output: text || "(sub-agent returned no text)" };
      } catch (e) {
        return { output: String(e instanceof Error ? e.message : e), isError: true };
      }
    },
  });

  registerTool({
    name: "background_task",
    description: "Start a self-contained subtask in the background and return its job id immediately — don't wait for it. Use for long, independent work. The user checks results with /jobs.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The subtask, with all the context the sub-agent needs." } },
      required: ["task"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(args) {
      const task = String(args.task ?? "");
      const id = startJob(task, async () => {
        const sub = new Agent({ client, model, session: Session.create(), onApprove, autoApprove: true, project: includeProject, compactAt: settings.compactAt });
        return sub.send(task, { quiet: true });
      });
      return { output: `Started background job ${id}. Check results with /jobs (don't wait on it).` };
    },
  });

  const agent = new Agent({
    client,
    model,
    session,
    onApprove,
    autoApprove,
    reasoning: flags.reasoning ?? settings.reasoning,
    project: includeProject,
    compactAt: settings.compactAt,
    history,
  });
  if (flags.strategy) agent.setStrategy(flags.strategy);
  if (flags.agent && !switchAgent(agent, flags.agent, settings)) console.error(`unknown agent: ${flags.agent} (configure in .ada/settings.json)`);

  setMode = (m: PermMode): void => {
    mode = m;
    agent.setPlanMode(m === "plan");
    agent.setAutoApprove(m === "auto");
  };
  setMode(autoApprove ? "auto" : "ask"); // apply the initial mode (e.g. --yolo → auto) consistently

  if (flags.tui && stdin.isTTY) {
    rl.close(); // hand stdin to the TUI so readline doesn't echo keystrokes too
    await runTui(agent, model);
    return;
  }

  console.log(`\nada — model ${model} via ${BACKEND}`);
  console.log("commands: /model [id]  /models  /next  /reasoning [low|medium|high|off]  /compact  /context  /exit");
  console.log("          \x1b[1mmode:\x1b[0m /ask /plan /auto (or /mode to cycle)  ·  /run  /fork  /tree  /rewind  /undo  /todos  /cost  /image  /paste");
  if (prompts.size) console.log(`prompt templates: ${[...prompts.keys()].map((k) => `/${k}`).join("  ")}`);
  if (exts.length) console.log(`extensions: ${exts.join("  ")}`);
  if (skills.length) console.log(`skills: ${skills.map((s) => s.name).join("  ")}`);
  if (mcp.length) console.log(`mcp: ${mcp.join("  ")}`);
  console.log("\x1b[2mduring a turn: Esc/Ctrl+C = interrupt · type + Enter = steer\x1b[0m\n");

  const pendingImages: string[] = []; // images attached via /image or /paste, sent with the next message
  for (;;) {
    if (stdin.isTTY) {
      const modeTag = mode === "plan" ? " · \x1b[33mplan\x1b[0m\x1b[2m" : mode === "auto" ? " · \x1b[31mauto\x1b[0m\x1b[2m" : " · ask";
      process.stdout.write(`\x1b[2m${model}${modeTag} · ~${agent.contextTokens()} tok\x1b[0m\n`);
    }
    let line: string;
    try {
      line = (await rl.question("\x1b[38;5;214m›\x1b[0m ")).trim();
    } catch {
      break; // stdin closed (Ctrl+D / EOF)
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/compact") {
      try {
        console.log(await agent.compactNow());
      } catch (e) {
        console.error(`[error] ${e instanceof Error ? e.message : e}`);
      }
      continue;
    }
    if (line === "/context") {
      console.log(`~${agent.contextTokens()} est. tokens in context`);
      continue;
    }
    if (line === "/tree") {
      printTree(session.file);
      continue;
    }
    if (line === "/fork") {
      session = Session.open(agent.fork());
      console.log(`\x1b[2mforked → new branch ${basename(session.file)}\x1b[0m`);
      continue;
    }
    if (line === "/rewind") {
      console.log(agent.rewind());
      continue;
    }
    if (line === "/cost") {
      console.log(agent.usageReport());
      continue;
    }
    if (line === "/undo") {
      console.log(undoAll());
      continue;
    }
    if (line === "/snapshot") {
      const t = snapshot();
      console.log(t ? `\x1b[38;5;214m✓\x1b[0m snapshot saved (${t.slice(0, 8)}) — /restore to roll back the whole tree` : "snapshot failed (not a git repo?)");
      continue;
    }
    if (line === "/restore") {
      console.log(restoreSnapshot() ? "\x1b[38;5;214m✓\x1b[0m restored the working tree to the last snapshot" : "nothing to restore (take a /snapshot first)");
      continue;
    }
    if (line === "/jobs") {
      console.log(renderJobs());
      continue;
    }
    if (line === "/todos") {
      console.log(renderTodos());
      continue;
    }
    if (line === "/ask" || line === "/auto" || line === "/plan" || line === "/mode") {
      const next: PermMode = line === "/mode" ? (mode === "ask" ? "plan" : mode === "plan" ? "auto" : "ask") : (line.slice(1) as PermMode);
      setMode(next);
      const blurb = { ask: "confirm each tool before it runs", plan: "ada plans but won't edit — /run to execute", auto: "run tools without asking (destructive bash still confirms)" }[next];
      console.log(`mode → \x1b[1m${next}\x1b[0m \x1b[2m(${blurb})\x1b[0m`);
      continue;
    }
    if (line === "/run") {
      if (mode !== "plan") {
        console.log("not in plan mode.");
        continue;
      }
      setMode("ask");
      console.log("\x1b[2mplan approved — executing…\x1b[0m");
      line = "Proceed and implement the plan above.";
    }
    if (line === "/models") {
      await printModels(client);
      continue;
    }
    if (line === "/catalog" || line.startsWith("/catalog ")) {
      console.log(catalogText(line.slice("/catalog".length).trim() || undefined));
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      const id = line.slice("/model".length).trim();
      if (id) {
        agent.setModel(id);
        model = id;
        console.log(`model → ${id}`);
      } else {
        console.log(`current model: ${model}`);
      }
      continue;
    }
    if (line === "/next") {
      if (scoped.length) {
        model = scoped[(scoped.indexOf(model) + 1) % scoped.length]!;
        agent.setModel(model);
        console.log(`model → ${model}`);
      } else {
        console.log("no --models scope set (start with --models a,b,c)");
      }
      continue;
    }
    if (line === "/reasoning" || line.startsWith("/reasoning ")) {
      const v = line.slice("/reasoning".length).trim();
      if (v === "low" || v === "medium" || v === "high") {
        agent.setReasoning(v);
        console.log(`reasoning → ${v}`);
      } else if (v === "off" || v === "none") {
        agent.setReasoning(undefined);
        console.log("reasoning → off");
      } else {
        console.log(`reasoning: ${agent.reasoning ?? "off"} (set: low | medium | high | off)`);
      }
      continue;
    }
    if (line === "/strategy" || line.startsWith("/strategy ")) {
      const v = line.slice("/strategy".length).trim();
      if (v) {
        agent.setStrategy(v);
        console.log(`strategy → ${v}`);
      } else {
        console.log(`strategy: ${agent.getStrategy()} (react | single | plan | multi | toolsmith)`);
      }
      continue;
    }
    if (line === "/agent" || line.startsWith("/agent ")) {
      const name = line.slice("/agent".length).trim();
      if (!name) console.log(`agents: ${Object.keys(settings.agents ?? {}).join(", ") || "(none — configure in .ada/settings.json)"}`);
      else if (switchAgent(agent, name, settings)) console.log(`agent → ${name}`);
      else console.log(`unknown agent: ${name}`);
      continue;
    }
    if (line === "/image" || line.startsWith("/image ")) {
      const p = line.slice("/image".length).trim();
      if (!p) {
        console.log("usage: /image <path>   (attaches an image to your next message)");
      } else {
        const img = loadImage(p);
        if (!img) console.log(`could not read image: ${p} (need .png/.jpg/.gif/.webp/.bmp)`);
        else {
          pendingImages.push(img.dataUrl);
          console.log(`\x1b[2m📎 ${img.name} (${Math.round(img.bytes / 1024)} KB) attached — ${pendingImages.length} image(s) queued; now type your question\x1b[0m`);
        }
      }
      continue;
    }
    if (line === "/paste") {
      const clipImg = readClipboardImage();
      if (clipImg) {
        pendingImages.push(clipImg);
        console.log(`\x1b[2m📎 image attached from clipboard — ${pendingImages.length} queued; now type your question\x1b[0m`);
        continue;
      }
      const clip = readClipboard();
      if (!clip) {
        console.log("clipboard empty or unavailable");
        continue;
      }
      console.log(`\x1b[2m(pasted ${clip.length} chars from clipboard)\x1b[0m`);
      line = clip;
    }
    if (line.startsWith("/")) {
      const cn = line.slice(1).split(/\s+/)[0]!;
      const cmd = getCommands().get(cn);
      if (cmd) {
        try {
          const out = await cmd.run(line.slice(1 + cn.length).trim());
          if (out) console.log(out);
        } catch (e) {
          console.error(`[command ${cn}] ${e instanceof Error ? e.message : e}`);
        }
        continue;
      }
    }
    let toSend = line;
    if (line.startsWith("/")) {
      const expanded = expandPrompt(prompts, line);
      if (expanded === null) {
        console.log(`unknown command: ${line.split(/\s+/)[0]} (chat without the leading /, or add .ada/prompts/<name>.md)`);
        continue;
      }
      toSend = expanded;
    }
    const abort = new AbortController();
    const steer: string[] = [];
    let lineBuf = "";
    const onData = (buf: Buffer): void => {
      const s = buf.toString("utf8");
      if (s === "\x03" || s === "\x1b" || (kbInterrupt !== undefined && s === kbInterrupt)) {
        abort.abort(); // Ctrl+C / Esc / configured key → interrupt this turn
        return;
      }
      if (s.startsWith("\x1b")) return; // ignore other escape sequences (arrow keys, etc.)
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          const m = lineBuf.trim();
          lineBuf = "";
          if (m) {
            steer.push(m);
            process.stdout.write(`\x1b[2m  ↳ queued (steers after this turn): ${m}\x1b[0m\n`);
          }
        } else if (ch === "\x7f") {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch >= " ") {
          lineBuf += ch;
        }
      }
    };
    turn = { onData };
    if (stdin.isTTY) rawOn(rl, onData);
    const turnStart = Date.now();
    track("turn", { model });
    const imgs = pendingImages.length ? pendingImages.slice() : undefined;
    pendingImages.length = 0;
    process.stdout.write("\n\x1b[38;5;214m◆\x1b[0m \x1b[1mada\x1b[0m\n");
    try {
      await agent.send(toSend, { signal: abort.signal, steer, images: imgs });
      if (!abort.signal.aborted && Date.now() - turnStart > 8000) notify("ada", "task complete");
    } catch (e) {
      track("error", { message: e instanceof Error ? e.message : String(e) });
      console.error(`\n[error] ${e instanceof Error ? e.message : e}`);
    } finally {
      if (stdin.isTTY) rawOff(rl, onData);
      turn = null;
    }
  }
  rl.close();
}

main().then(
  () => process.exit(0), // explicit exit: node-pty (bash) and stdin can keep the loop alive otherwise
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
