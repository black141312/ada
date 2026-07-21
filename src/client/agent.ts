// The agentic loop. Talks ONLY to the ada backend via the OpenAI SDK; the backend
// routes to the real provider. Streams text, runs tool calls, persists every message.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type OpenAI from "openai";
import { loadBrain } from "./brain.ts";
import { compact, estimateTokens, isContextOverflowError } from "./compaction.ts";
import { MarkdownStreamer } from "./render.ts";
import { type Tool, type ToolResult, isDestructive, toolByName, tools } from "./tools.ts";
import { afterTool, beforeTool, transformInput } from "./hooks.ts";
import { configuredServers } from "./mcp.ts";
import { priceOf } from "./models-dev.ts";
import { permissionFor } from "./settings.ts";
import { routeConfident, routeSkills } from "./skills.ts";
import { recallBlock } from "./memory.ts";
import { Session } from "./session.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
/** Structured turn events — for a caller (e.g. an IDE service) that wants more than plain text.
 *  When `onEvent` is set on SendCtrl, `send()` emits these instead of writing to stdout. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; callId: string; name: string; detail: string }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean; display?: string }
  | { type: "done"; text: string; usage: string; context?: number };
type SendCtrl = { signal?: AbortSignal; steer?: string[]; quiet?: boolean; images?: string[]; onReplyStart?: () => void; onEvent?: (e: AgentEvent) => void };
type ToolCall = { id: string; name: string; args: string };
type StepResult = { content: string; toolCalls: ToolCall[] };
type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

export type ApprovalDecision = "yes" | "all" | "no";
export type OnApprove = (toolName: string, summary: string) => Promise<ApprovalDecision>;

function projectContext(): string {
  let guide = "";
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) {
      try {
        guide = `\n\nProject guide (${f}):\n${readFileSync(p, "utf8").slice(0, 8000)}`;
        break;
      } catch {
        /* ignore unreadable */
      }
    }
  }
  // Repo map ("brain") — cached folder structure + symbols so the agent starts oriented.
  let brain = "";
  try {
    const map = loadBrain();
    if (map) brain = `\n\nProject map (auto-generated — file paths and their top-level symbols; use grep/codebase_search to go deeper):\n${map}`;
  } catch {
    /* brain is best-effort — never block a session on it */
  }
  return guide + brain;
}

function systemPrompt(includeProject: boolean): string {
  return (
    [
      "You are ada, a minimal coding agent running in a terminal, in the spirit of pi, Codex, and Cursor.",
      `Working directory: ${process.cwd()}`,
      `Platform: ${process.platform}`,
      "Tools: read_file, write_file, edit_file, bash, ls, grep, glob, codebase_search, web_fetch, web_search, lsp_diagnostics. Use grep/glob/ls to explore the codebase — or codebase_search when you're looking for code by MEANING rather than an exact string; read a file before editing it; prefer edit_file for changes to existing files; web_fetch to read a URL, web_search to find one; lsp_diagnostics to check a file for errors after editing; apply_patch for multi-file changes; ask_user only when genuinely blocked.",
      "Specialized skills are available: call list_skills to browse them (by category or filter), then use_skill to load one before a specialized task.",
      "When the user states a durable preference, project convention, decision, correction, or constraint worth recalling in later sessions ('always use X', 'we deploy via Y', 'my name is Z', 'never touch W'), call remember_fact. Do NOT remember transient task state, anything already in AGENTS.md/CLAUDE.md, or secrets/keys/tokens (those are refused). Relevant memories are auto-recalled at the start of a turn.",
      "Be concise. Don't narrate routine actions or pad with preamble. When you have enough information to act, act. Ask only when genuinely blocked or before destructive, irreversible actions.",
    ].join("\n") + (includeProject ? projectContext() : "")
  );
}

function buildApiTools(): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Pull every top-level JSON object out of a string (brace-matched, string-aware).
function extractJsonObjects(s: string): Array<Record<string, unknown>> {
  const t = s.trim();
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    if (v && typeof v === "object") return [v as Record<string, unknown>];
  } catch {
    /* not one clean value — scan for embedded objects below */
  }
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (--depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(t.slice(start, i + 1));
          if (o && typeof o === "object") out.push(o);
        } catch {
          /* unbalanced — skip */
        }
        start = -1;
      }
    }
  }
  return out;
}

// Some providers (notably Ollama over a streaming connection) fail to parse a model's tool
// call into the structured tool_calls field and leak it as raw JSON in the text content.
// Recover it: if the reply IS a JSON tool call for a real tool, hand it back as a call.
export function parseTextToolCalls(content: string): Array<{ name: string; args: string }> | null {
  let s = content.trim();
  if (!s) return null;
  const fence = s.match(/^```(?:json|tool(?:_call)?)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1]!.trim();
  const blocks: string[] = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi; // Qwen/Hermes wrap calls in tags
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) blocks.push(m[1]!);
  if (!blocks.length) blocks.push(s);
  const out: Array<{ name: string; args: string }> = [];
  for (const b of blocks) {
    for (const o of extractJsonObjects(b)) {
      const name = typeof o.name === "string" ? o.name : typeof o.tool === "string" ? (o.tool as string) : "";
      if (!name || !toolByName.has(name)) continue;
      const raw = o.arguments ?? o.args ?? o.parameters ?? {};
      out.push({ name, args: typeof raw === "string" ? raw : JSON.stringify(raw) });
    }
  }
  return out.length ? out : null;
}

const COMPACT_AT = Number(process.env.ADA_COMPACT_AT) || 100_000;

const PLAN_NOTE =
  "PLAN MODE: do not write, edit, or run commands. Investigate with read-only tools if needed, then present a concise numbered plan and stop. The user will approve before you execute.";

const DECOMPOSE_NOTE =
  "Break the user's request into 2-5 independent subtasks that can each be done on their own. Output one subtask per line — nothing else.";

// ---- orchestration: pluggable agent architectures over a shared Engine ----
// The Engine holds the harness primitives (streaming, tool-call recovery, compaction, approval,
// sessions). An Orchestrator is a Strategy that only decides WHEN to call those primitives, so a
// new agent architecture is one Orchestrator and zero changes to the engine.

/** The harness primitives a strategy composes. */
export interface Engine {
  step(opts?: { allowTools?: boolean; note?: string }): Promise<StepResult | null>; // null = aborted
  runTools(calls: ToolCall[]): Promise<void>;
  say(s: string): void;
  interrupted(): void;
  addSystem(text: string): void;
  aborted(): boolean;
  drainSteer(): boolean;
  spawn(prompt: string): Promise<string>;
  soleIntegration(): string | null;
  readDocs(name: string): Promise<string>;
  writeSkills(drafts: { name: string; content: string }[]): Promise<number>;
}

export interface Orchestrator {
  readonly name: string;
  run(e: Engine): Promise<void>;
}

const reAct: Orchestrator = {
  name: "react", // reason → act → observe → repeat (the default; = the original loop)
  async run(e) {
    let nudged = false; // guard so a stubbornly-silent model can't loop forever
    for (;;) {
      const turn = await e.step();
      if (!turn) return;
      if (!turn.toolCalls.length) {
        // Some models (e.g. after marking a todo list "done") end a turn with NO tool calls and NO
        // text — leaving the user with tool output but no answer. Nudge once for the final response.
        if (!turn.content.trim() && !nudged) {
          nudged = true;
          e.addSystem(
            "You stopped without giving the user an answer. Based on what you've already found, write your final response to the user now. Don't call more tools unless truly necessary.",
          );
          continue;
        }
        e.say("\n");
        if (e.drainSteer()) continue;
        return;
      }
      nudged = false; // real work resumed — allow another nudge later if needed
      await e.runTools(turn.toolCalls);
      if (e.aborted()) {
        e.interrupted();
        return;
      }
      e.drainSteer();
    }
  },
};

const singleShot: Orchestrator = {
  name: "single", // one model turn, no tools — quick Q&A
  async run(e) {
    if (await e.step({ allowTools: false })) e.say("\n");
  },
};

const planExecute: Orchestrator = {
  name: "plan", // read-only plan first, then execute it
  async run(e) {
    if (!(await e.step({ allowTools: false, note: PLAN_NOTE }))) return;
    e.addSystem("Now execute the plan above, step by step, using your tools.");
    for (;;) {
      const turn = await e.step();
      if (!turn) return;
      if (!turn.toolCalls.length) {
        e.say("\n");
        return;
      }
      await e.runTools(turn.toolCalls);
      if (e.aborted()) {
        e.interrupted();
        return;
      }
    }
  },
};

const splitLines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 1);

const multiAgent: Orchestrator = {
  name: "multi", // decompose → fan out to subagents → synthesize
  async run(e) {
    const plan = await e.step({ allowTools: false, note: DECOMPOSE_NOTE });
    if (!plan) return;
    const tasks = splitLines(plan.content).filter((t) => t.length > 8);
    if (!tasks.length) {
      e.say("\n");
      return;
    }
    e.say(`\n\x1b[2m• delegating ${tasks.length} subtasks\x1b[0m\n`);
    const results = await Promise.all(tasks.map((t) => e.spawn(t)));
    e.addSystem(`Subagent results:\n\n${results.map((r, i) => `### ${tasks[i]}\n${r}`).join("\n\n")}\n\nSynthesize the final answer for the user.`);
    await e.step({ allowTools: false });
    e.say("\n");
  },
};

const toolsmith: Orchestrator = {
  name: "toolsmith", // read the lone integration's docs → subagents author skills for it
  async run(e) {
    const integ = e.soleIntegration();
    if (!integ) {
      e.say("\x1b[33mtoolsmith needs exactly one integration configured (ada mcp add <name>).\x1b[0m\n");
      return;
    }
    e.say(`\x1b[2m• reading ${integ} docs…\x1b[0m\n`);
    const docs = await e.readDocs(integ);
    const plan = await e.step({
      allowTools: false,
      note: `These are the ${integ} integration's capabilities:\n\n${docs}\n\nList 4-8 capability AREAS to build skills for — one short kebab-case slug per line, nothing else.`,
    });
    if (!plan) return;
    const areas = splitLines(plan.content)
      .map((a) => a.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter((a) => a.length > 1)
      .slice(0, 8);
    if (!areas.length) {
      e.say("\x1b[33mtoolsmith: could not derive capability areas from the docs.\x1b[0m\n");
      return;
    }
    e.say(`\x1b[2m• ${integ}: ${areas.join(", ")}\x1b[0m\n`);
    const drafts = await Promise.all(
      areas.map(async (area) => ({
        name: `${integ}-${area}`,
        content: await e.spawn(
          `Write an ada SKILL.md for the "${integ}" integration's "${area}" capability. Output ONLY the file, in EXACTLY this format:\n` +
            `---\nname: ${integ}-${area}\ndescription: <one imperative line, <=110 chars>\ncategory: integration-${integ}\n---\n\n# <Title>\n\n<one-sentence intro>\n\n1. <step>\n... (4-6 steps that reference the relevant ${integ}__* tools)\n\n## Rules\n- <3-5 rules>\n\n` +
            `Base it strictly on these ${integ} tools:\n${docs}`,
        ),
      })),
    );
    const n = await e.writeSkills(drafts);
    e.say(`\n\x1b[38;5;214m✓\x1b[0m toolsmith wrote ${n} ${integ} skills → .ada/skills/  (browse: list_skills category=integration-${integ})\n`);
  },
};

const ORCHESTRATORS: Record<string, Orchestrator> = { react: reAct, single: singleShot, plan: planExecute, multi: multiAgent, toolsmith };

/** A short, transient hint naming the most relevant skills for a request (or null if none stand out). */
function suggestSkillNote(query: string): string | null {
  const top = routeSkills(query, 3).filter((r) => r.score >= 2);
  if (!top.length) return null;
  return `Possibly relevant skills for this request — call use_skill to load one if it helps, otherwise ignore: ${top.map((r) => `${r.name} (${r.description})`).join("; ")}`;
}

/** The only integration configured in .ada/mcp.json, or null if zero or several. */
export function soleIntegration(): string | null {
  const servers = configuredServers();
  return servers.length === 1 ? servers[0]! : null;
}

/** "Docs" for an integration = the descriptions + schemas of its registered <name>__* tools. */
export function readIntegrationDocs(name: string): string {
  const tools_ = [...toolByName.values()].filter((t) => t.name.startsWith(`${name}__`));
  if (!tools_.length) return `(no tools registered for "${name}" — connect it in a trusted project first)`;
  return tools_.map((t) => `## ${t.name}\n${t.description}\nparameters: ${JSON.stringify(t.parameters)}`).join("\n\n");
}

/** Persist subagent-authored skills under the project's .ada/skills/. Returns how many were written. */
export function writeProjectSkills(drafts: { name: string; content: string }[]): number {
  let n = 0;
  for (const d of drafts) {
    const body = String(d.content ?? "").trim();
    if (!body.startsWith("---")) continue; // skip non-skill output
    const dir = resolve(process.cwd(), ".ada", "skills", d.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `${body}\n`);
    n++;
  }
  return n;
}

// $ per 1M tokens [input, output] for a few common models; substring-matched.
const PRICES: Record<string, [number, number]> = {
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "claude-opus": [5, 25],
  "claude-sonnet": [3, 15],
  "claude-haiku": [1, 5],
  "deepseek": [0.27, 1.1],
};
function priceFor(model: string): [number, number] | null {
  const md = priceOf(model); // models.dev catalog (prefetched), if available
  if (md) return md;
  for (const k of Object.keys(PRICES)) if (model.includes(k)) return PRICES[k]!;
  return null;
}

function summarize(args: unknown): string {
  const s = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Human-readable (label, detail) for a tool call — clearer than dumping the raw args JSON. */
export function describeCall(name: string, args: Record<string, unknown>): { label: string; detail: string } {
  const a = args ?? {};
  const s = (v: unknown): string => (v == null ? "" : String(v));
  switch (name) {
    case "bash":
      return { label: "shell", detail: s(a.command) };
    case "read_file":
      return { label: "read", detail: s(a.path) };
    case "write_file":
      return { label: "write", detail: s(a.path) };
    case "edit_file":
      return { label: "edit", detail: s(a.path) };
    case "apply_patch":
      return { label: "patch", detail: "" };
    case "ls":
      return { label: "list", detail: s(a.path) || "." };
    case "glob":
      return { label: "find", detail: s(a.pattern) };
    case "grep":
      return { label: "search", detail: s(a.pattern) };
    case "web_fetch":
      return { label: "fetch", detail: s(a.url) };
    case "web_search":
      return { label: "web", detail: s(a.query) };
    case "use_skill":
      return { label: "skill", detail: s(a.name) };
    case "spawn_agent":
      return { label: "sub-agent", detail: s(a.task) };
    case "background_task":
      return { label: "background", detail: s(a.task) };
    default:
      if (name.includes("__")) return { label: name.split("__")[0]!, detail: name.split("__").slice(1).join("__") };
      return { label: name, detail: summarize(a) };
  }
}

/** What permission the call is asking for, in plain words (for the approval prompt). */
export function permPhrase(name: string, destructive: boolean): string {
  if (name === "bash") return destructive ? "⚠ run a shell command that may modify your system" : "run a shell command on your machine";
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return "create or modify files on disk";
  if (name === "web_fetch" || name === "web_search") return "make a network request";
  if (name.includes("__")) return `use the ${name.split("__")[0]} connector`;
  return `run the ${name} tool`;
}

async function safeRun(tool: Tool, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await tool.run(args);
  } catch (e) {
    return { output: String(e), isError: true };
  }
}

function isTransient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  if (status && [408, 409, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /timeout|econn|temporarily|overloaded|rate.?limit|fetch failed|socket hang/.test(msg);
}

/** Run `fn`, retrying transient failures (429/5xx/network) with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal | undefined, max = 3): Promise<T> {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || attempt >= max || !isTransient(e)) throw e;
      process.stdout.write(`\x1b[2m[retrying in ${(delay / 1000).toFixed(1)}s — ${e instanceof Error ? e.message : e}]\x1b[0m\n`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export class Agent {
  model: string;
  reasoning?: "low" | "medium" | "high";
  planMode = false;
  private client: OpenAI;
  private messages: Msg[];
  private session: Session;
  private onApprove: OnApprove;
  private autoApprove: boolean;
  private compactAt: number;
  private apiTools: ToolDef[];
  private promptTokens = 0;
  private completionTokens = 0;
  private lastAssistant = "";
  private strategy = "react"; // orchestration architecture (see ORCHESTRATORS)
  private pendingNote: string | null = null; // transient skill-routing hint for the next model turn
  private pendingMemory: string | null = null; // transient auto-recalled memories for the next model turn
  private project: boolean; // cwd is trusted → load project skills/memory

  constructor(opts: {
    client: OpenAI;
    model: string;
    session: Session;
    onApprove: OnApprove;
    autoApprove?: boolean;
    reasoning?: "low" | "medium" | "high";
    project?: boolean;
    compactAt?: number;
    history?: Msg[];
  }) {
    this.client = opts.client;
    this.model = opts.model;
    this.reasoning = opts.reasoning;
    this.session = opts.session;
    this.onApprove = opts.onApprove;
    this.autoApprove = !!opts.autoApprove;
    this.compactAt = opts.compactAt || COMPACT_AT;
    this.apiTools = buildApiTools(); // snapshot the registry (incl. extension/skill/MCP tools) at construction
    this.project = opts.project ?? true;
    this.messages = [{ role: "system", content: systemPrompt(this.project) }, ...(opts.history ?? [])];
  }

  setModel(m: string): void {
    this.model = m;
  }

  setStrategy(s: string): void {
    this.strategy = s;
  }

  getStrategy(): string {
    return this.strategy;
  }

  /** Inject a system message (used by named-agent profiles). */
  pushSystem(text: string): void {
    const m: Msg = { role: "system", content: text };
    this.messages.push(m);
    this.session.append(m);
  }

  setOnApprove(fn: OnApprove): void {
    this.onApprove = fn;
  }

  setReasoning(r: "low" | "medium" | "high" | undefined): void {
    this.reasoning = r;
  }

  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
  }

  setPlanMode(on: boolean): void {
    this.planMode = on;
  }

  /** Branch the conversation: future messages go to a new session; returns its file. */
  fork(): string {
    this.session = Session.fork(this.session.file, this.messages);
    return this.session.file;
  }

  /** Time-travel: drop the last turn from context, back to the previous user message. */
  rewind(): string {
    let i = this.messages.length - 1;
    while (i > 0 && this.messages[i]!.role !== "user") i--;
    if (i <= 0) return "Nothing to rewind.";
    const removed = this.messages.length - i;
    this.messages = this.messages.slice(0, i);
    return `Rewound ${removed} message(s); context now ~${estimateTokens(this.messages)} est. tokens.`;
  }

  async send(input: string, ctrl?: SendCtrl): Promise<string> {
    let replyStarted = false;
    const say = (s: string): void => {
      if (ctrl?.onEvent) {
        if (s.trim()) ctrl.onEvent({ type: "text", delta: s });
        return;
      }
      if (ctrl?.quiet) return;
      if (!replyStarted && s.trim()) {
        replyStarted = true;
        ctrl?.onReplyStart?.(); // first visible output of the turn — let the TUI swap spinner → ◆
        s = s.replace(/^\n+/, ""); // already on a fresh line; drop the leading blank
      }
      process.stdout.write(s);
    };
    const interrupted = (): void => say("\n\x1b[2m[interrupted]\x1b[0m\n");
    const drainSteer = (): boolean => {
      const queued = ctrl?.steer?.splice(0) ?? [];
      for (const s of queued) {
        const m: Msg = { role: "user", content: s };
        this.messages.push(m);
        this.session.append(m);
      }
      return queued.length > 0;
    };

    input = await transformInput(input);
    const userMsg: Msg = {
      role: "user",
      content: ctrl?.images?.length
        ? ([{ type: "text", text: input }, ...ctrl.images.map((url) => ({ type: "image_url", image_url: { url } }))] as OpenAI.Chat.Completions.ChatCompletionContentPart[])
        : input,
    };
    this.messages.push(userMsg);
    this.session.append(userMsg);

    if (estimateTokens(this.messages) > this.compactAt) await this.autoCompact("size threshold");
    if (!ctrl?.quiet) {
      // Auto-recall: the few memories relevant to this input, injected transiently for this turn only.
      this.pendingMemory = recallBlock(input, !!this.project);
      // Orchestrate skills: when one clearly fits, apply it (inject its procedure into context so
      // even a weak model follows it, persisted across the tool loop). Otherwise, a soft hint.
      const fit = routeConfident(input);
      if (fit) {
        const sys: Msg = { role: "system", content: `A skill fits this request: "${fit.name}". Follow its procedure for this task unless it clearly doesn't fit what was asked, in which case ignore it and proceed.\n\n${fit.body}` };
        this.messages.push(sys);
        this.session.append(sys);
        say(`\x1b[2m↳ skill: ${fit.name}\x1b[0m\n`);
      } else {
        this.pendingNote = suggestSkillNote(input);
      }
    }

    const engine = this.makeEngine(ctrl, say, interrupted, drainSteer);
    await (ORCHESTRATORS[this.strategy] ?? reAct).run(engine);
    ctrl?.onEvent?.({ type: "done", text: this.lastAssistant, usage: this.usageReport(), context: this.contextTokens() });
    return this.lastAssistant;
  }

  // ---- Engine: the harness primitives an Orchestrator composes ----

  private makeEngine(ctrl: SendCtrl | undefined, say: (s: string) => void, interrupted: () => void, drainSteer: () => boolean): Engine {
    const signal = ctrl?.signal;
    return {
      step: (opts) => this.modelTurn(ctrl, say, interrupted, opts),
      runTools: (calls) => this.execTools(calls, ctrl, say),
      say,
      interrupted,
      addSystem: (text) => {
        const m: Msg = { role: "system", content: text };
        this.messages.push(m);
        this.session.append(m);
      },
      aborted: () => !!signal?.aborted,
      drainSteer,
      spawn: (prompt) => this.spawnSub(prompt),
      soleIntegration,
      readDocs: async (name) => readIntegrationDocs(name),
      writeSkills: async (drafts) => writeProjectSkills(drafts),
    };
  }

  /** A fresh, headless sub-agent (autoApprove, quiet). Returns its final text. */
  private async spawnSub(prompt: string): Promise<string> {
    const sub = new Agent({ client: this.client, model: this.model, session: Session.create(), onApprove: this.onApprove, autoApprove: true, project: false });
    return sub.send(prompt, { quiet: true });
  }

  /** One model turn: stream, collect content + tool calls (recovering leaked ones), push the
   *  assistant message. Returns null if interrupted. Retries once on context overflow. */
  private async modelTurn(ctrl: SendCtrl | undefined, say: (s: string) => void, interrupted: () => void, opts?: { allowTools?: boolean; note?: string }): Promise<StepResult | null> {
    const signal = ctrl?.signal;
    if (signal?.aborted) {
      interrupted();
      return null;
    }
    const suggest = this.pendingNote;
    const memory = this.pendingMemory;
    this.pendingNote = null; // consume once — the routing hint applies to this turn only
    this.pendingMemory = null; // recall is per-turn + transient — never pushed to messages/session
    const note = [opts?.note ?? (this.planMode ? PLAN_NOTE : null), memory, suggest].filter(Boolean).join("\n\n") || null;
    let overflowRetried = false;
    for (;;) {
      const create = () =>
        this.client.chat.completions.create(
          {
            model: this.model,
            messages: note ? [...this.messages, { role: "system", content: note }] : this.messages,
            tools: this.apiTools,
            tool_choice: opts?.allowTools === false ? "none" : "auto",
            stream: true,
            stream_options: { include_usage: true },
            ...(this.reasoning ? { reasoning_effort: this.reasoning } : {}),
          },
          signal ? { signal } : undefined,
        );
      let stream: Awaited<ReturnType<typeof create>>;
      try {
        stream = await withRetry(create, signal);
      } catch (e) {
        if (signal?.aborted) {
          interrupted();
          return null;
        }
        if (!overflowRetried && isContextOverflowError(e)) {
          overflowRetried = true;
          await this.autoCompact("context overflow");
          continue;
        }
        throw e;
      }

      let content = "";
      const md = new MarkdownStreamer();
      const calls: Array<{ id: string; name: string; args: string }> = [];
      // If the reply opens like a leaked tool call (raw JSON / <tool_call> / fence), hold the
      // text back instead of streaming it — we may recover it as a real call after the stream.
      let bufferMode = false;
      let sniffed = false;
      try {
        for await (const chunk of stream) {
          if (chunk.usage) {
            this.promptTokens += chunk.usage.prompt_tokens ?? 0;
            this.completionTokens += chunk.usage.completion_tokens ?? 0;
          }
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            if (!sniffed && content.trim()) {
              sniffed = true;
              bufferMode = /^(```(?:json|tool)|<tool_call>|[[{])/i.test(content.trimStart());
            }
            if (!bufferMode) say(md.push(delta.content));
          }
          for (const tc of delta?.tool_calls ?? []) {
            let entry = calls[tc.index];
            if (!entry) {
              entry = { id: "", name: "", args: "" };
              calls[tc.index] = entry;
            }
            if (tc.id) entry.id = tc.id;
            else if (!entry.id) entry.id = `call_${tc.index}`; // some backends omit streamed ids — consumers key events on callId
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      } catch (e) {
        say(md.end());
        if (signal?.aborted) {
          interrupted();
          return null;
        }
        throw e;
      }
      if (!bufferMode) say(md.end());

      let toolCalls = calls.filter((c): c is { id: string; name: string; args: string } => !!c);

      // Recover tool calls the provider leaked into the text (Ollama-over-stream, weak models).
      if (!toolCalls.length && bufferMode) {
        const parsed = parseTextToolCalls(content);
        if (parsed) {
          toolCalls = parsed.map((p, i) => ({ id: `text_${this.completionTokens}_${i}`, name: p.name, args: p.args }));
          content = "";
        } else {
          say(md.push(content) + md.end()); // looked like a call but isn't runnable — show it
        }
      }

      const assistantMsg: Msg = toolCalls.length
        ? {
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
          }
        : { role: "assistant", content };
      this.messages.push(assistantMsg);
      this.session.append(assistantMsg);
      this.lastAssistant = content;
      return { content, toolCalls };
    }
  }

  /** Run a turn's tool calls (read-only in parallel, gated ones sequentially with approval) and
   *  append one tool message per call. */
  private async execTools(toolCalls: ToolCall[], ctrl: SendCtrl | undefined, say: (s: string) => void): Promise<void> {
    const signal = ctrl?.signal;
    const printCall = (callId: string, name: string, args: Record<string, unknown>): void => {
      const d = describeCall(name, args);
      const detail = d.detail.length > 100 ? `${d.detail.slice(0, 99)}…` : d.detail;
      const label = d.label.charAt(0).toUpperCase() + d.label.slice(1); // Claude-Code-style: ⏺ Read(path)
      ctrl?.onEvent?.({ type: "tool_call", callId, name, detail: d.detail });
      say(`\n\x1b[32m⏺\x1b[0m \x1b[1m${label}\x1b[0m\x1b[2m(${detail})\x1b[0m\n`);
    };
    const printResult = (callId: string, name: string, r: ToolResult): void => {
      ctrl?.onEvent?.({ type: "tool_result", callId, name, output: r.output, isError: !!r.isError, display: r.display });
      if (r.display) return void say(`${r.display}\n`); // rich display (e.g. edit diff) is its own result block
      const first = (r.output || "").split("\n").find((l) => l.trim()) ?? "";
      const line = first.length > 80 ? `${first.slice(0, 79)}…` : first; // one-line summary under the ⏺ call
      if (r.isError) say(`\x1b[31m  ⎿ ${line}\x1b[0m\n`);
      else if (line) say(`\x1b[2m  ⎿ ${line}\x1b[0m\n`);
    };
    const argsOf = (s: string): Record<string, unknown> => {
      try {
        return JSON.parse(s || "{}");
      } catch {
        return {};
      }
    };
    const runTool = async (tool: Tool, name: string, a: Record<string, unknown>): Promise<ToolResult> => {
      const pre = await beforeTool(name, a);
      if (pre.deny) return { output: pre.deny };
      return afterTool(name, pre.args, await safeRun(tool, pre.args));
    };

    const results = new Array<ToolResult>(toolCalls.length);
    const parallel: number[] = []; // read-only tools — safe to run concurrently
    for (let i = 0; i < toolCalls.length; i++) {
      const c = toolCalls[i]!;
      const args = argsOf(c.args);
      const tool = toolByName.get(c.name);
      if (signal?.aborted) {
        results[i] = { output: "[interrupted by user]" }; // keep every tool_call paired with a result
        continue;
      }
      if (!tool) {
        printCall(c.id, c.name, args);
        results[i] = { output: `Unknown tool: ${c.name}`, isError: true };
        continue;
      }
      const perm = permissionFor(c.name, summarize(args)); // configured allow/ask/deny rule, if any
      if (perm === "deny") {
        printCall(c.id, c.name, args);
        results[i] = { output: "Denied by permission policy.", isError: true };
        printResult(c.id, c.name, results[i]!);
        continue;
      }
      if (!tool.needsApproval && perm !== "ask") {
        parallel.push(i);
        continue;
      }
      // gated tool (or a rule forces "ask") → sequential (so prompts and same-file writes don't race)
      printCall(c.id, c.name, args);
      if (this.planMode && tool.needsApproval) {
        results[i] = { output: "Plan mode: not executing — finish the plan; the user approves with /run." };
        printResult(c.id, c.name, results[i]!);
        continue;
      }
      const forceConfirm = c.name === "bash" && isDestructive(String(args.command ?? ""));
      const autoOk = (this.autoApprove || perm === "allow") && !forceConfirm && perm !== "ask";
      if (autoOk) {
        results[i] = await runTool(tool, c.name, args);
      } else {
        const decision = await this.onApprove(c.name, `${permPhrase(c.name, forceConfirm)}\n${describeCall(c.name, args).detail}`);
        if (decision === "all") {
          this.autoApprove = true;
          results[i] = await runTool(tool, c.name, args);
        } else if (decision === "no") {
          results[i] = { output: "Denied by user." };
        } else {
          results[i] = await runTool(tool, c.name, args);
        }
      }
      printResult(c.id, c.name, results[i]!);
    }
    await Promise.all(
      parallel.map(async (i) => {
        const c = toolCalls[i]!;
        const args = argsOf(c.args);
        printCall(c.id, c.name, args);
        results[i] = await runTool(toolByName.get(c.name)!, c.name, args);
        printResult(c.id, c.name, results[i]!);
      }),
    );
    for (let i = 0; i < toolCalls.length; i++) {
      const toolMsg: Msg = { role: "tool", tool_call_id: toolCalls[i]!.id, content: results[i]!.output };
      this.messages.push(toolMsg);
      this.session.append(toolMsg);
    }
  }

  async compactNow(): Promise<string> {
    const before = estimateTokens(this.messages);
    const result = await compact(this.client, this.model, this.messages);
    if (!result) return "Nothing to compact yet.";
    this.messages = result.messages;
    return `Compacted context: ~${before} → ~${estimateTokens(this.messages)} est. tokens.`;
  }

  contextTokens(): number {
    return estimateTokens(this.messages);
  }

  usageReport(): string {
    const p = priceFor(this.model);
    const cost = p ? (this.promptTokens / 1e6) * p[0] + (this.completionTokens / 1e6) * p[1] : null;
    return `tokens: ${this.promptTokens} in / ${this.completionTokens} out${cost !== null ? ` · ~$${cost.toFixed(4)}` : " · (no price table for this model)"}`;
  }

  private async autoCompact(reason: string): Promise<void> {
    const result = await compact(this.client, this.model, this.messages);
    if (result) {
      this.messages = result.messages;
      process.stdout.write(`\x1b[2m[compacted earlier context — ${reason}]\x1b[0m\n`);
    }
  }
}
