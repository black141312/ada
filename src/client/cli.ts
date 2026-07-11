// ada client REPL. Talks only to the ada backend.

import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";
import { Agent, type AgentEvent, type ApprovalDecision, type OnApprove } from "./agent.ts";
import { ApprovalRegistry, newId, sseFrame } from "./agent-server.ts";
import { expandPrompt, loadPrompts } from "./prompts.ts";
import { Session, list, type SessionMeta } from "./session.ts";
import { deleteCredential, getCredential, listCredentials, setCredential } from "../server/credentials.ts";
import { deviceGrant, deviceLogin, oauthConfig } from "../server/oauth.ts";
import { addTrust, isTrusted, loadSettings, setActiveAgentPermissions, setGlobal, setOrgPermissions, type PermRule, type Settings } from "./settings.ts";
import { getCommands, loadExtensions } from "./extensions.ts";
import { registerTool, setAsker } from "./tools.ts";
import { addRemoteSkill, loadSkills, registerSkillTool } from "./skills.ts";
import { memoryCommand, registerMemoryTools } from "./memory.ts";
import { addConnector, listConnectors, loadMcpServers, removeConnector } from "./mcp.ts";
import { addExtension, selfUpdate } from "./pkg.ts";
import { runTui } from "./tui-mode.ts";
import { loadImage } from "./image.ts";
import { notify, readClipboard, readClipboardImage } from "./platform.ts";
import { undoAll } from "./checkpoint.ts";
import { restore as restoreSnapshot, snapshot } from "./snapshot.ts";
import { catalogText, prefetch } from "./models-dev.ts";
import { ensureBackend, isLocalBackend } from "./autostart.ts";
import { popularModels } from "./models.ts";
import { route } from "../server/router.ts"; // pure model-id → provider mapping (static table, safe client-side)
import { renderJobs, startJob } from "./background.ts";
import { renderTodos } from "./todos.ts";
import { track } from "./telemetry.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type RL = ReturnType<typeof createInterface>;

// Which backend the client talks to: env wins, then a saved /connect setting, then local default.
const BACKEND = process.env.ADA_BACKEND_URL ?? loadSettings(false).backendUrl ?? "http://localhost:8787/v1";
// The client's route() table is only authoritative for a LOCAL, same-version backend (the one we
// autostart). Against a remote/custom backend the provider is the backend's business — we must not
// assert "@provider" as fact. So provider tags are shown only when the backend is local.
const LOCAL_BACKEND = isLocalBackend(BACKEND);
/** route(m) as a display tag — empty for remote backends, where our static table may not match. */
const routeTag = (m: string): string => (LOCAL_BACKEND ? route(m) : "");

/** A stored login credential, sent as the bearer so the backend can identify us. An OIDC SSO seat
 *  key (ada_sk_…) wins — it's a durable, server-minted, disableable bearer (see oidcLogin). A seat
 *  key is only honored by the backend that minted it, so a stray one sent elsewhere just 401s. */
function identityToken(): string | undefined {
  const oidc = getCredential("oidc");
  if (oidc?.type === "oauth" && oidc.key) return oidc.key;
  for (const p of ["github", "google"]) {
    const c = getCredential(p);
    if (c?.type === "oauth" && c.access) return c.access;
  }
  return undefined;
}

function clientKey(): string {
  return process.env.ADA_CLIENT_KEY ?? identityToken() ?? loadSettings(false).backendKey ?? "dev";
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

async function fetchModelIds(client: OpenAI, timeoutMs?: number): Promise<string[]> {
  const ids: string[] = [];
  const res = await client.models.list(timeoutMs ? { timeout: timeoutMs } : undefined); // bound best-effort calls (maxRetries is 0, so no retry multiplication)
  for await (const m of res) ids.push(m.id);
  return ids.sort();
}

interface ProviderInfo {
  name: string;
  configured: boolean;
  source: "env" | "key" | "keyless" | "none";
  reachable?: boolean;
}

/** What services the backend can actually route to (GET /v1/providers). Null if it can't say. */
async function fetchProviders(): Promise<ProviderInfo[] | null> {
  try {
    const r = await fetch(`${BACKEND}/providers`, { headers: { authorization: `Bearer ${clientKey()}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return ((await r.json()) as { providers?: ProviderInfo[] }).providers ?? null;
  } catch {
    return null;
  }
}

/** One dim line of truth: which services the BACKEND can route to. e.g. "services: openrouter ✓ ·
 *  ollama ✗ not running". For a remote backend we qualify the wording — the facts describe the
 *  backend host, not the user's machine, and local /connect can't change a remote backend. */
function servicesLine(provs: ProviderInfo[]): string {
  const parts: string[] = [];
  for (const p of provs) {
    if (p.name === "ollama") {
      const down = LOCAL_BACKEND ? "not running" : "not reachable from backend";
      parts.push(p.reachable ? "ollama \x1b[32m✓\x1b[0m\x1b[2m" : `ollama \x1b[31m✗\x1b[0m\x1b[2m ${down}`);
    } else if (p.configured) {
      parts.push(`${p.name} \x1b[32m✓\x1b[0m\x1b[2m${p.source === "env" ? " (env)" : ""}`);
    }
  }
  const more = provs.filter((p) => !p.configured && p.name !== "ollama").length;
  if (more) parts.push(LOCAL_BACKEND ? `+${more} connectable · \x1b[36m/connect\x1b[0m\x1b[2m` : `+${more} connectable on the backend`);
  return `\x1b[2mservices: ${parts.join(" · ")}\x1b[0m`;
}

/** Render labeled rows inside a rounded box, accent labels aligned in a shared column. Rows longer
 *  than the terminal width are truncated with … so the right border always aligns (matching the
 *  design mockup, which horizontally clips a too-wide line rather than wrapping it). */
function boxedRows(rows: Array<{ label: string; body: string }>): string[] {
  const ACCENT = "\x1b[38;5;214m", DIM = "\x1b[2m", R = "\x1b[0m";
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const plain = rows.map((r) => `${r.label.padEnd(labelW)}  ${r.body}`); // uncolored, for width/truncation math
  const inner = Math.min(Math.max(...plain.map((p) => p.length)), Math.max(48, stdout.columns || 100) - 4);
  const mid = plain.map((p) => {
    const fit = p.length > inner ? `${p.slice(0, inner - 1)}…` : p.padEnd(inner);
    return `${DIM}│${R} ${ACCENT}${fit.slice(0, labelW)}${R}${fit.slice(labelW)} ${DIM}│${R}`; // accent the label span
  });
  return [`${DIM}╭${"─".repeat(inner + 2)}╮${R}`, ...mid, `${DIM}╰${"─".repeat(inner + 2)}╯${R}`];
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINK_VERBS = ["Thinking", "Working", "Reasoning", "Crunching", "Pondering", "Churning", "Cooking", "Noodling", "Scheming"];

/** A transient "thinking" line for the readline REPL: spinner + cycling verb + live elapsed timer +
 *  interrupt hint, redrawn in place. Returns stop() which clears the line. No-op off a TTY. */
function thinkingSpinner(): () => void {
  if (!stdout.isTTY) return () => {};
  const start = Date.now();
  let i = 0;
  let verb = THINK_VERBS[Math.floor(Math.random() * THINK_VERBS.length)]!;
  const draw = (): void => {
    const secs = Math.floor((Date.now() - start) / 1000);
    stdout.write(`\r\x1b[2K\x1b[38;5;214m${SPINNER[i]}\x1b[0m \x1b[2m${verb}… (${secs}s · esc to interrupt)\x1b[0m`);
  };
  draw();
  const t = setInterval(() => {
    i = (i + 1) % SPINNER.length;
    if (i === 0 && Math.random() < 0.5) verb = THINK_VERBS[Math.floor(Math.random() * THINK_VERBS.length)]!;
    draw();
  }, 90);
  return () => {
    clearInterval(t);
    stdout.write("\r\x1b[2K");
  };
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

/** Full-list fallback: arrow-select the first 40 ids (TTY) or a numbered list, or type an id. */
async function pickFromAll(ids: string[], rl: RL): Promise<string> {
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

async function pickModel(client: OpenAI, rl: RL, preIds?: string[]): Promise<string> {
  let ids = preIds;
  if (!ids) {
    console.log("Fetching available models…");
    try {
      ids = await fetchModelIds(client);
    } catch (e) {
      reportModelsError(e);
      ids = [];
    }
  }
  if (!ids.length) return (await rl.question("Enter a model id: ")).trim();

  // Lead with a curated shortlist of popular models (newest per family) — easier than scrolling the
  // full OpenRouter list. Plus an escape to type any id, and to browse everything.
  const pop = popularModels(ids);
  if (pop.length && stdin.isTTY) {
    const ENTER = "\x1b[36m✎ enter a model id…\x1b[0m";
    const ALL = `\x1b[36m▸ browse all ${ids.length} models…\x1b[0m`;
    const items = [...pop.map((p) => `${p.label.padEnd(13)} \x1b[2m${p.id}\x1b[0m`), ENTER, ...(ids.length > pop.length ? [ALL] : [])];
    const i = await select(rl, "Popular models  (↑/↓ · Enter · Esc to type an id):", items);
    if (i === null || items[i] === ENTER) return (await rl.question("model id: ")).trim();
    if (items[i] === ALL) return pickFromAll(ids, rl);
    return pop[i]!.id;
  }
  return pickFromAll(ids, rl);
}

/** Resolve a model at interactive startup. If none are reachable (Ollama down, no provider key), we
 *  DON'T show the "enter a model id" prompt — we offer to /connect a provider instead of dead-ending,
 *  then re-check. Returns "" if the user declines or still has nothing (caller exits cleanly). */
async function resolveModel(client: OpenAI, rl: RL): Promise<string> {
  // Distinguish "backend answered with an empty list" (→ offer /connect) from "backend threw"
  // (unreachable / 401). A local provider key can't fix a down or remote backend, so on a throw we
  // report the real cause instead of steering into /connect.
  let ids: string[];
  try {
    ids = await fetchModelIds(client);
  } catch (e) {
    reportModelsError(e);
    return "";
  }
  if (!ids.length) {
    console.log("\x1b[33mNo model is reachable yet.\x1b[0m Run local models with `ollama serve`, or connect a hosted provider.");
    const ans = (await rl.question("Connect a provider now (OpenRouter, etc.)? [Y/n] ")).trim().toLowerCase();
    if (ans === "n" || ans === "no") return "";
    await connectCommand(rl); // a provider key takes effect immediately — the backend re-reads creds
    ids = await fetchModelIds(client).catch(() => [] as string[]);
    if (!ids.length) {
      console.log("Still no model — start Ollama or finish /connect, then run ada again.");
      return "";
    }
  }
  return pickModel(client, rl, ids); // pass the ids we already have — no re-fetch, no extra prompt
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
 * Tool-approval prompt: a one-line "ada wants to <permission> — <target>" title over an arrow-select
 * list — Yes · Yes, don't ask again (→ auto) · No. On a choice the list collapses to a single
 * confirmation line so the transcript stays compact. `summary` is "<permission phrase>\n<detail>".
 */
async function approvePrompt(rl: RL, name: string, summary: string): Promise<ApproveChoice> {
  const nl = summary.indexOf("\n");
  const risk = (nl >= 0 ? summary.slice(0, nl) : summary) || `run the ${name} tool`;
  const detail = nl >= 0 ? summary.slice(nl + 1).trim() : "";
  const danger = risk.startsWith("⚠");
  const what = risk.replace(/^⚠ /, "");
  const cols = (stdout.columns || 80) - 4;
  const short = detail && detail.length > cols ? `${detail.slice(0, cols - 1)}…` : detail;
  if (!stdin.isTTY) {
    const ans = (await rl.question(`? ${risk}${detail ? ` (${short})` : ""}  [y]es / [a]uto / [N]o `)).trim().toLowerCase();
    return ans[0] === "y" ? "yes" : ans[0] === "a" ? "auto" : "no";
  }
  const title = `${danger ? "\x1b[31m⚠ " : "\x1b[33m"}ada wants to ${what}\x1b[0m${detail ? ` \x1b[2m— ${short}\x1b[0m` : ""}`;
  const items = ["Yes", "Yes, and don't ask again this session", "No"];
  const i = await select(rl, title, items); // arrow-select; Esc → null → No (safe default)
  const val: ApproveChoice = i === 0 ? "yes" : i === 1 ? "auto" : "no";
  // Collapse the menu. The title can WRAP (the permission phrase isn't width-capped), so rewind by its
  // actual physical-row count, not a hardcoded 1 — else a wrapped title leaves a stray fragment.
  // ponytail: assumes the 3 fixed items don't wrap (they fit at ≥40 cols); ok for real terminals.
  const width = stdout.columns || 80;
  const titleRows = Math.max(1, Math.ceil(title.replace(/\x1b\[[0-9;]*m/g, "").length / width));
  stdout.write(`\x1b[${items.length + titleRows}A\x1b[0J`);
  const mark = val === "no" ? "\x1b[31m✗\x1b[0m no" : val === "auto" ? "\x1b[32m✓\x1b[0m yes · won't ask again" : "\x1b[32m✓\x1b[0m yes";
  stdout.write(`${mark} \x1b[2m${what}\x1b[0m\n`);
  return val;
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

interface AuthMethods {
  methods: string[];
  oidc?: { issuer: string; clientId: string; deviceAuthEndpoint: string; tokenEndpoint: string; scope: string; exchangePath: string };
  oidcError?: string;
}

/** Ask the backend which login methods it offers (so the client needs no OIDC env of its own). */
async function fetchAuthMethods(): Promise<AuthMethods | null> {
  try {
    const r = await fetch(`${BACKEND}/auth/methods`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.json()) as AuthMethods;
  } catch {
    return null;
  }
}

/** OIDC SSO login (model B): device-flow against the org IdP using the backend-advertised config,
 *  then exchange the id_token for a durable seat key stored under the "oidc" credential. */
async function oidcLogin(): Promise<boolean> {
  const m = await fetchAuthMethods();
  if (!m?.oidc) {
    console.log(m?.oidcError ? `SSO unavailable: ${m.oidcError}` : "this backend does not offer OIDC SSO.");
    return false;
  }
  const { clientId, deviceAuthEndpoint, tokenEndpoint, scope, exchangePath } = m.oidc;
  try {
    const tok = await deviceGrant("SSO", { clientId, deviceUrl: deviceAuthEndpoint, tokenUrl: tokenEndpoint, scope }, (s) => console.log(s));
    const idToken = tok.id_token as string | undefined;
    if (!idToken) throw new Error("IdP returned no id_token — ensure the 'openid' scope is granted");
    const r = await fetch(`${BACKEND}${exchangePath}`, { method: "POST", headers: { authorization: `Bearer ${idToken}` } });
    if (!r.ok) throw new Error(`exchange failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
    const { seat_key, user, role } = (await r.json()) as { seat_key?: string; user?: string; role?: string };
    if (!seat_key) throw new Error("backend returned no seat_key");
    await setCredential("oidc", { type: "oauth", key: seat_key });
    console.log(`Logged in via SSO as ${user} (${role}).`);
    return true;
  } catch (e) {
    console.error(`SSO login failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Better Auth account login — device flow served by the ada backend itself (no external IdP).
 *  The session token is stored under the "oidc" credential so clientKey() picks it up exactly
 *  like a seat key, with zero extra wiring. */
async function accountLogin(): Promise<boolean> {
  const origin = BACKEND.replace(/\/v1\/?$/, "");
  try {
    const r = await fetch(`${origin}/api/auth/device/code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "ada-cli" }),
    });
    if (!r.ok) throw new Error(`device/code HTTP ${r.status}`);
    const d = (await r.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval?: number; expires_in?: number };
    console.log(`Open ${origin}${d.verification_uri_complete ?? d.verification_uri} and enter code: ${d.user_code}`);
    const deadline = Date.now() + (d.expires_in ?? 600) * 1000;
    let interval = (d.interval ?? 5) * 1000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, interval));
      const t = await fetch(`${origin}/api/auth/device/token`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: "ada-cli" }),
      });
      const j = (await t.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (j.access_token) {
        await setCredential("oidc", { type: "oauth", key: j.access_token });
        console.log("Logged in — account session stored.");
        return true;
      }
      if (j.error === "slow_down") interval += 5000;
      else if (j.error && j.error !== "authorization_pending") throw new Error(j.error);
    }
    throw new Error("device code expired");
  } catch (e) {
    console.error(`account login failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Run the device flow for `provider`; returns true on success (credential stored). */
async function loginFlow(provider: string): Promise<boolean> {
  if (provider === "account" || provider === "email") return accountLogin();
  if (provider === "oidc" || provider === "sso") return oidcLogin();
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

/** Fetch org policy from an enterprise backend and apply its tool rules locally (restrictive-wins
 *  merge in settings.permissionFor; the backend enforces the model allowlist regardless). Caches the
 *  last-good policy under ~/.ada so a transient fetch failure falls back to known rules instead of
 *  silently dropping them. No-op against a non-enterprise backend. */
async function applyOrgPolicy(): Promise<void> {
  const cacheFile = join(homedir(), ".ada", "org-policy.json");
  const enterprise = clientKey().startsWith("ada_sk_"); // a seat key ⇒ this is an enterprise backend
  try {
    const r = await fetch(`${BACKEND}/policy`, { headers: { authorization: `Bearer ${clientKey()}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const policy = (await r.json()) as { permissions?: PermRule[] };
    setOrgPermissions(policy.permissions ?? null);
    try {
      mkdirSync(join(homedir(), ".ada"), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(policy));
    } catch {
      /* cache best-effort */
    }
    if (policy.permissions?.length) console.error(`\x1b[2m↳ org policy applied (${policy.permissions.length} rule${policy.permissions.length === 1 ? "" : "s"})\x1b[0m`);
  } catch (e) {
    if (!enterprise) return; // non-enterprise backend — local rules only, silently
    // Enterprise backend unreachable — fall back to the last policy we saw, and say so loudly.
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { permissions?: PermRule[] };
      setOrgPermissions(cached.permissions ?? null);
      console.error(`\x1b[33m[warn] could not fetch org policy (${e instanceof Error ? e.message : e}) — using cached rules.\x1b[0m`);
    } catch {
      console.error(`\x1b[33m[warn] could not fetch org policy (${e instanceof Error ? e.message : e}) and no cache — org tool rules NOT applied this session.\x1b[0m`);
    }
  }
}

/** Startup login check: probe the backend; if it says 401, offer to sign in and rebuild the client. */
async function ensureAuth(rl: RL, client: OpenAI): Promise<OpenAI> {
  let status: number;
  try {
    const r = await fetch(`${BACKEND}/whoami`, { headers: { authorization: `Bearer ${clientKey()}` }, signal: AbortSignal.timeout(3000) });
    status = r.status;
  } catch {
    return client; // backend unreachable — the model fetch will report it
  }
  if (status !== 401) return client; // 200 = already authorized, or backend is open (dev)
  // Prefer the org IdP if the backend advertises OIDC SSO; else fall back to a locally-configured
  // GitHub/Google OAuth app.
  const methods = await fetchAuthMethods();
  const provider = methods?.methods.includes("oidc") ? "oidc" : ["github", "google"].find((p) => oauthConfig(p));
  if (!provider) {
    console.log("\x1b[33mthis backend requires login, but no login method is available (backend offers no SSO and no ADA_OAUTH_* is set).\x1b[0m");
    return client;
  }
  const label = provider === "oidc" ? `your org (${methods?.oidc?.issuer ?? "SSO"})` : provider;
  const ans = (await rl.question(`\x1b[33mnot logged in — sign in with ${label}? [Y/n] \x1b[0m`)).trim().toLowerCase();
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

// Providers the local backend can route to (each just needs an API key stored in the credential store).
const CONNECTABLE = ["openrouter", "openai", "anthropic", "cloudflare", "groq", "google", "mistral", "deepseek", "xai", "together", "dashscope"];

/** /connect — pick a provider (saves its API key; the local backend routes to it) or a backend
 *  endpoint (saves the URL/key so new sessions point there). Interactive menu, or /connect <name|url>. */
async function connectCommand(rl: RL, arg?: string): Promise<void> {
  if (arg) {
    if (/^https?:\/\//.test(arg)) return connectBackend(rl, arg);
    if (CONNECTABLE.includes(arg)) return connectProvider(rl, arg);
    console.log(`unknown target "${arg}". Run /connect for the menu, or pass a provider name or a backend URL.`);
    return;
  }
  // Connected-state from the BACKEND's point of view (it holds the keys). Local credentials are only
  // a meaningful fallback for a LOCAL backend — against a remote one they don't reflect its keys, so
  // we don't claim "✓ connected" from them (would be a false positive).
  const backendProvs = await fetchProviders();
  const connected = (p: string): boolean => (backendProvs ? !!backendProvs.find((b) => b.name === p)?.configured : LOCAL_BACKEND && !!getCredential(p)?.key);
  const items = [...CONNECTABLE.map((p) => `${p}${connected(p) ? "  \x1b[2m✓ connected\x1b[0m" : ""}`), "custom backend / Cloudflare Worker URL…"];
  const i = await select(rl, "Connect ada to:", items);
  if (i == null) return;
  return i < CONNECTABLE.length ? connectProvider(rl, CONNECTABLE[i]!) : connectBackend(rl);
}

async function connectProvider(rl: RL, p: string): Promise<void> {
  const key = (await rl.question(`API key for ${p} (blank to cancel): `)).trim();
  if (!key) return console.log("cancelled");
  await setCredential(p, { type: "api_key", key });
  console.log(`\x1b[32m✓ connected to ${p}\x1b[0m — key saved (~/.ada/credentials.json). The local backend uses it now and in new sessions.`);
  const remote = loadSettings(false).backendUrl;
  if (remote) console.log(`\x1b[33mnote: you're pointed at a remote backend (${remote}) — provider keys live on THAT server, not here.\x1b[0m`);
}

async function connectBackend(rl: RL, preset?: string): Promise<void> {
  const url = (preset ?? (await rl.question("backend URL (e.g. https://ada.you.workers.dev/v1): "))).trim();
  if (!url) return console.log("cancelled");
  const key = (await rl.question("seat/bearer key for it (blank = dev): ")).trim();
  setGlobal({ backendUrl: url, ...(key ? { backendKey: key } : {}) });
  console.log(`\x1b[32m✓ ada backend set to ${url}\x1b[0m — saved. New sessions will use it (restart ada to apply).`);
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
const NO_BACKEND = new Set(["mcp", "skill", "worktree", "wt", "catalog", "share", "memory"]);

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "--version" || sub === "-v" || sub === "version") {
    // Before anything else — must not auto-start a backend just to print a version.
    console.log(`ada ${adaVersion()}`);
    return;
  }
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
  if (sub === "memory") {
    memoryCommand(process.argv.slice(3), isTrusted(process.cwd()));
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
    // Agent Client Protocol bridge over stdio (JSON-RPC 2.0, newline-delimited). Handles
    // initialize / session/new / session/prompt, and streams session/update notifications
    // (agent_message_chunk + tool_call/tool_call_update) while a turn runs — the shape ACP editors
    // like Zed render live. Still experimental until exercised against a real ACP client.
    const trusted = isTrusted(process.cwd());
    const settings = loadSettings(trusted);
    await loadExtensions(trusted);
    registerSkillTool(loadSkills(trusted)); registerMemoryTools(trusted);
    await loadMcpServers(trusted);
    const client = makeClient();
    await applyOrgPolicy(); // enterprise org rules apply to acp sessions too
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
    const ACP_SESSION = newId("acp");
    const update = (update: object): void => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ACP_SESSION, update } });
    let acpCtrl: AbortController | null = null; // the in-flight prompt's abort handle (session/cancel)
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
        else if (msg.method === "session/new" || msg.method === "newSession") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: ACP_SESSION } });
        else if (msg.method === "session/cancel" || msg.method === "cancel") {
          acpCtrl?.abort();
          if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else if (msg.method === "session/prompt" || msg.method === "prompt") {
          const p = msg.params ?? {};
          const blocks = (p.prompt ?? p.text) as unknown;
          const text = Array.isArray(blocks) ? blocks.map((b) => (b as { text?: string }).text ?? "").join("") : String(blocks ?? "");
          acpCtrl = new AbortController();
          try {
            await agent.send(text, {
              signal: acpCtrl.signal,
              onEvent: (e: AgentEvent) => {
                if (e.type === "text") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.delta } });
                else if (e.type === "tool_call") update({ sessionUpdate: "tool_call", toolCallId: e.callId, title: `${e.name} ${e.detail}`.trim(), status: "in_progress" });
                else if (e.type === "tool_result") update({ sessionUpdate: "tool_call_update", toolCallId: e.callId, status: e.isError ? "failed" : "completed" });
              },
            });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: acpCtrl.signal.aborted ? "cancelled" : "end_turn" } });
          } catch (e) {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
          } finally {
            acpCtrl = null;
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
    registerSkillTool(loadSkills(trusted)); registerMemoryTools(trusted);
    await loadMcpServers(trusted);
    const client = makeClient();
    await applyOrgPolicy(); // enterprise org rules apply to serve sessions too
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
      ctrl: AbortController | null; // set while a turn runs — doubles as the busy flag
      steer: string[]; // queued mid-turn user messages, drained by the agent between steps
      mode: "ask" | "plan" | "auto";
    }
    const sessions = new Map<string, AgentSession>();
    // `resumeFile` reattaches to an existing on-disk transcript (e.g. after `ada serve` restarted) —
    // its history replays into the new in-memory Agent so the conversation picks up where it left off.
    const makeSession = (m: string, resumeFile?: string): { id: string; rec: AgentSession } => {
      const session = resumeFile ? Session.open(resumeFile) : Session.create();
      const history = resumeFile ? (session.load() as unknown as Msg[]) : undefined;
      const rec: AgentSession = { agent: undefined as unknown as Agent, registry: new ApprovalRegistry(), emit: null, file: session.file, ctrl: null, steer: [], mode: "ask" };
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
          if (resume) {
            // A live in-memory session may still be appending to that transcript (e.g. the IDE lost
            // its SSE stream and *assumed* a restart) — two Agents on one JSONL interleave twin
            // conversations. Point the caller at the live session instead of forking the file.
            const live = [...sessions.entries()].find(([, r]) => r.file === resume);
            if (live) {
              res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "that transcript belongs to a live session — reuse it (or DELETE it first)", sessionId: live[0], busy: !!live[1].ctrl }));
              return;
            }
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
        if (rec.ctrl) {
          // One turn at a time per session — two interleaved prompts would corrupt one conversation.
          res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "a turn is already running on this session — abort it or wait for done" }));
          return;
        }
        rec.ctrl = new AbortController(); // claim the session before any await, so a racing second prompt sees busy
        // If the client dies MID-BODY (e.g. a dropped multi-MB image upload), 'end' never fires and
        // the claim above would brick the session with a permanent 409 — release it on 'close'.
        req.on("close", () => {
          if (!req.complete) {
            rec.ctrl = null;
            rec.steer.length = 0;
          }
        });
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          let text = "";
          let images: string[] | undefined;
          try {
            const j = JSON.parse(body || "{}") as { text?: string; images?: string[] };
            text = String(j.text ?? "");
            if (Array.isArray(j.images) && j.images.length) images = j.images.map(String);
          } catch {
            /* empty prompt */
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          // If the client drops the SSE stream mid-turn (IDE reload/crash), abort the turn — else it
          // runs headless, and in ask mode parks forever on an approval no one can see or answer.
          res.on("close", () => {
            if (!res.writableEnded) {
              rec.ctrl?.abort();
              rec.registry.abortAll();
            }
          });
          rec.emit = (frame) => res.write(frame);
          try {
            await rec.agent.send(text, { signal: rec.ctrl!.signal, steer: rec.steer, images, onEvent: (e: AgentEvent) => res.write(sseFrame(e)) });
          } catch (e) {
            res.write(sseFrame({ type: "error", message: e instanceof Error ? e.message : String(e) }));
          } finally {
            rec.emit = null;
            rec.ctrl = null;
            rec.steer.length = 0;
            res.end();
          }
        });
        return;
      }
      const abortMatch = req.method === "POST" && url.pathname.match(/^\/v1\/sessions\/([^/]+)\/abort$/);
      if (abortMatch) {
        const rec = sessions.get(abortMatch[1]!);
        if (!rec) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        const wasRunning = !!rec.ctrl;
        rec.ctrl?.abort();
        rec.registry.abortAll(); // a turn parked on an unanswered approval must not stay stuck
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, wasRunning }));
        return;
      }
      const steerMatch = req.method === "POST" && url.pathname.match(/^\/v1\/sessions\/([^/]+)\/steer$/);
      if (steerMatch) {
        const rec = sessions.get(steerMatch[1]!);
        if (!rec) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let text = "";
          try {
            text = String((JSON.parse(body || "{}") as { text?: string }).text ?? "");
          } catch {
            /* stays empty */
          }
          if (!text || !rec.ctrl) {
            // steering only makes sense mid-turn; when idle, just send the next prompt instead
            res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: rec.ctrl ? "empty text" : "no turn running — send a prompt instead" }));
            return;
          }
          rec.steer.push(text);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        });
        return;
      }
      const modeMatch = req.method === "PATCH" && url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (modeMatch) {
        const rec = sessions.get(modeMatch[1]!);
        if (!rec) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let mode: string | undefined;
          try {
            mode = (JSON.parse(body || "{}") as { mode?: string }).mode;
          } catch {
            /* stays undefined */
          }
          if (mode !== "ask" && mode !== "plan" && mode !== "auto") {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: 'mode must be "ask" | "plan" | "auto"' }));
            return;
          }
          rec.mode = mode;
          rec.agent.setPlanMode(mode === "plan");
          rec.agent.setAutoApprove(mode === "auto");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
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
        const rec = sessions.get(delMatch[1]!);
        rec?.ctrl?.abort(); // don't orphan a running turn
        rec?.registry.abortAll();
        const existed = sessions.delete(delMatch[1]!);
        res.writeHead(existed ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ ok: existed }));
        return;
      }
      res.writeHead(404).end();
    }).listen(port, () =>
      console.log(
        `ada HTTP API on http://localhost:${port}  ·  model ${model || "(none — set one)"}\n` +
          `  one-shot:    POST /v1/prompt {"text":"…"}\n` +
          `  interactive: POST /v1/sessions → {sessionId}   (GET lists resumable transcripts)\n` +
          `               POST /v1/sessions/:id/prompt {"text":"…","images"?:[…]}  (SSE: text/tool_call/tool_result/approval_request/done)\n` +
          `               POST /v1/sessions/:id/approve {"id":"…","decision":"yes"|"all"|"no"}\n` +
          `               POST /v1/sessions/:id/abort · /steer {"text":"…"} · PATCH /v1/sessions/:id {"mode":"ask"|"plan"|"auto"}`,
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
    registerSkillTool(loadSkills(trusted)); registerMemoryTools(trusted);
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
    await applyOrgPolicy(); // org tool rules bind headless runs too (CI is the classic bypass path)
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
  registerSkillTool(skills); registerMemoryTools(includeProject);
  const mcp = await loadMcpServers(includeProject);

  client = await ensureAuth(rl, client); // always check login at startup; prompt if the backend says 401
  await applyOrgPolicy(); // enterprise backends push org tool rules; no-op otherwise

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
    model = await resolveModel(client, rl);
    if (model) setGlobal({ model }); // remember the pick — so next launch boots straight to chat, not the picker
  }
  if (!model) {
    rl.close();
    return;
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

  console.log(`\nada — model ${model} ${routeTag(model) ? `\x1b[2m→ ${routeTag(model)}\x1b[0m ` : ""}via ${BACKEND}`);
  {
    const provs = await fetchProviders();
    if (provs) console.log(servicesLine(provs));
  }
  for (const line of boxedRows([
    { label: "commands", body: "/model [id]  /models  /next  /reasoning [low|medium|high|off]  /compact  /context  /exit" },
    { label: "mode", body: "/ask /plan /auto  (/mode to cycle)  ·  /run  /fork  /tree  /rewind  /undo  /todos  /cost  /image  /paste" },
  ])) console.log(line);
  if (prompts.size) console.log(`prompt templates: ${[...prompts.keys()].map((k) => `/${k}`).join("  ")}`);
  if (exts.length) console.log(`extensions: ${exts.join("  ")}`);
  if (mcp.length) console.log(`mcp: ${mcp.join("  ")}`);
  console.log("\x1b[2mduring a turn: Esc/Ctrl+C = interrupt · type + Enter = steer\x1b[0m\n");

  const pendingImages: string[] = []; // images attached via /image or /paste, sent with the next message
  for (;;) {
    if (stdin.isTTY) {
      // Minimal pre-prompt line: just the context size. Show plan/auto (a safety signal — tools run
      // without asking in auto) but not the default "ask", and not model@provider (it's in the header).
      const modeTag = mode === "plan" ? "\x1b[33mplan\x1b[0m\x1b[2m · " : mode === "auto" ? "\x1b[31mauto\x1b[0m\x1b[2m · " : "";
      process.stdout.write(`\x1b[2m${modeTag}~${agent.contextTokens()} tok\x1b[0m\n`);
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
    if (line === "/memory" || line.startsWith("/memory ")) {
      memoryCommand(line.slice(7).trim().split(/\s+/).filter(Boolean), includeProject);
      continue;
    }
    if (line === "/connect" || line.startsWith("/connect ")) {
      await connectCommand(rl, line.slice(8).trim() || undefined);
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
      const next = id || (await pickModel(client, rl)); // bare /model opens the picker; /model <id> sets directly
      if (next && next !== model) {
        if (id) {
          // A hand-typed id that isn't in the backend's list is usually a typo — warn with the closest
          // real id, but still allow it (some upstreams accept ids the list doesn't show, e.g.
          // OpenRouter's `~family`). Bound the lookup (3s) so a slow provider can't stall a switch,
          // and accept the documented `groq/…`, `together/…`, `copilot/…` prefixes (upstream lists
          // are bare — the adapter strips the prefix before forwarding).
          const ids = await fetchModelIds(client, 3000).catch(() => [] as string[]);
          const bare = next.startsWith(`${route(next)}/`) ? next.slice(route(next).length + 1) : next;
          if (ids.length && !ids.includes(next) && !ids.includes(bare)) {
            const close = fuzzyPick(bare.replace(/^~/, ""), ids);
            console.log(`\x1b[33m⚠ '${next}' isn't in the backend's model list${close ? ` — did you mean ${close}?` : ""} (sending anyway)\x1b[0m`);
          }
        }
        agent.setModel(next);
        model = next;
        setGlobal({ model: next }); // persist — ada remembers your last model across launches
        console.log(`model → ${next}${routeTag(next) ? ` \x1b[2m(${routeTag(next)})\x1b[0m` : ""}`);
      }
      continue;
    }
    if (line === "/next") {
      if (scoped.length) {
        model = scoped[(scoped.indexOf(model) + 1) % scoped.length]!;
        agent.setModel(model);
        console.log(`model → ${model}${routeTag(model) ? ` \x1b[2m(${routeTag(model)})\x1b[0m` : ""}`);
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
    process.stdout.write("\n");
    const stopSpin = thinkingSpinner(); // show a live "thinking…" indicator until the first output
    let replyOpened = false;
    const openReply = (): void => {
      if (replyOpened) return;
      replyOpened = true;
      stopSpin();
      process.stdout.write("\x1b[38;5;214m◆\x1b[0m  "); // reply streams inline right after the bullet (no "ada" label)
    };
    try {
      await agent.send(toSend, { signal: abort.signal, steer, images: imgs, onReplyStart: openReply });
      if (!abort.signal.aborted && Date.now() - turnStart > 8000) notify("ada", "task complete");
    } catch (e) {
      track("error", { message: e instanceof Error ? e.message : String(e) });
      console.error(`\n[error] ${e instanceof Error ? e.message : e}`);
    } finally {
      stopSpin(); // clear the spinner if the turn ended before any output (e.g. interrupted)
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
