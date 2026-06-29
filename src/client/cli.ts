// ada client REPL. Talks only to the ada backend.

import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";
import { Agent, type ApprovalDecision, type OnApprove } from "./agent.ts";
import { expandPrompt, loadPrompts } from "./prompts.ts";
import { Session, list, type SessionMeta } from "./session.ts";
import { deleteCredential, getCredential, listCredentials } from "../server/credentials.ts";
import { deviceLogin, oauthConfig } from "../server/oauth.ts";
import { addTrust, isTrusted, loadSettings } from "./settings.ts";
import { getCommands, loadExtensions } from "./extensions.ts";
import { registerTool } from "./tools.ts";
import { loadSkills, registerSkillTool } from "./skills.ts";
import { addConnector, listConnectors, loadMcpServers, removeConnector } from "./mcp.ts";
import { addExtension, selfUpdate } from "./pkg.ts";
import { runTui } from "./tui-mode.ts";
import { loadImage } from "./image.ts";
import { notify, readClipboard, readClipboardImage } from "./platform.ts";
import { undoAll } from "./checkpoint.ts";
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
  rl.pause();
  if (stdin.isTTY) stdin.setRawMode(true);
  return await new Promise<number | null>((res) => {
    const cleanup = (): void => {
      stdin.off("data", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      rl.resume();
    };
    const onKey = (buf: Buffer): void => {
      const s = buf.toString("utf8");
      if (s === "\x1b[A" || s === "k") {
        idx = (idx - 1 + items.length) % items.length;
        draw(false);
      } else if (s === "\x1b[B" || s === "j") {
        idx = (idx + 1) % items.length;
        draw(false);
      } else if (s === "\r" || s === "\n") {
        cleanup();
        res(idx);
      } else if (s === "\x03" || s === "\x1b") {
        cleanup();
        res(null);
      }
    };
    stdin.on("data", onKey);
    stdin.resume();
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

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "login" || sub === "logout") {
    await authCommand(sub, process.argv[3]);
    return;
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
  const flags = parseArgs(process.argv.slice(2));
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
  const onApprove: OnApprove = async (name, summary): Promise<ApprovalDecision> => {
    if (turn && stdin.isTTY) rawOff(rl, turn.onData); // hand stdin back to readline for the prompt
    const ans = (await rl.question(`\x1b[33m? run ${name} ${summary}  [y]es / [a]ll / [N]o \x1b[0m`)).trim().toLowerCase();
    if (turn && stdin.isTTY) rawOn(rl, turn.onData);
    if (ans === "a" || ans === "all") return "all";
    if (ans === "y" || ans === "yes") return "yes";
    return "no";
  };

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

  if (flags.tui && stdin.isTTY) {
    rl.close(); // hand stdin to the TUI so readline doesn't echo keystrokes too
    await runTui(agent, model);
    return;
  }

  console.log(`\nada — model ${model} via ${BACKEND}`);
  console.log("commands: /model [id]  /models  /next  /reasoning [low|medium|high|off]  /compact  /context  /exit");
  console.log("          /plan  /run  /fork (branch)  /tree  /rewind  /undo  /todos  /cost  /image <path>  /paste");
  if (prompts.size) console.log(`prompt templates: ${[...prompts.keys()].map((k) => `/${k}`).join("  ")}`);
  if (exts.length) console.log(`extensions: ${exts.join("  ")}`);
  if (skills.length) console.log(`skills: ${skills.map((s) => s.name).join("  ")}`);
  if (mcp.length) console.log(`mcp: ${mcp.join("  ")}`);
  console.log("\x1b[2mduring a turn: Esc/Ctrl+C = interrupt · type + Enter = steer\x1b[0m\n");

  const pendingImages: string[] = []; // images attached via /image or /paste, sent with the next message
  for (;;) {
    if (stdin.isTTY) process.stdout.write(`\x1b[2m${model}${agent.planMode ? " · \x1b[33mplan\x1b[0m\x1b[2m" : ""} · ~${agent.contextTokens()} tok\x1b[0m\n`);
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
    if (line === "/todos") {
      console.log(renderTodos());
      continue;
    }
    if (line === "/plan") {
      agent.setPlanMode(!agent.planMode);
      console.log(agent.planMode ? "\x1b[33mplan mode ON\x1b[0m — ada plans but won't edit. /run to execute · /plan to exit." : "plan mode off");
      continue;
    }
    if (line === "/run") {
      if (!agent.planMode) {
        console.log("not in plan mode.");
        continue;
      }
      agent.setPlanMode(false);
      console.log("\x1b[2mplan approved — executing…\x1b[0m");
      line = "Proceed and implement the plan above.";
    }
    if (line === "/models") {
      await printModels(client);
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
