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
import { isTrusted, loadSettings, permissionFor } from "./settings.ts";
import { routeConfident, routeSkills } from "./skills.ts";
import { recallBlock } from "./memory.ts";
import { Session } from "./session.ts";
import { fileURLToPath } from "node:url";
import { runIsolatedWorker } from "./worker.ts";

/** "tokens: 1566 in / 18 out · ~$0.0016" → numbers. A child worker reports usage as that string;
 *  parsing it back beats plumbing a second channel for three integers. */
function parseUsageLine(s: string): { promptTokens: number; completionTokens: number; cost: number } {
  const t = /tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out/.exec(s);
  const c = /~\$([0-9.]+)/.exec(s);
  return { promptTokens: t ? +t[1]! : 0, completionTokens: t ? +t[2]! : 0, cost: c ? +c[1]! : 0 };
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
/** Structured turn events — for a caller (e.g. an IDE service) that wants more than plain text.
 *  When `onEvent` is set on SendCtrl, `send()` emits these instead of writing to stdout. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; callId: string; name: string; detail: string }
  | { type: "tool_result"; callId: string; name: string; output: string; isError: boolean; display?: string }
  | { type: "done"; text: string; usage: string; context?: number };
type SendCtrl = {
  signal?: AbortSignal;
  steer?: string[];
  /** Suppress stdout. An OUTPUT concern only — it must never change what the agent does. */
  quiet?: boolean;
  /** This turn came from a parent agent, not a person: the task is already scoped, so skill routing
   *  and memory recall are skipped. Distinct from `quiet` — `--json` is quiet but still a real user
   *  turn, and conflating the two silently disabled skills for every scripted run. */
  delegated?: boolean;
  images?: string[];
  onReplyStart?: () => void;
  onEvent?: (e: AgentEvent) => void;
};
type ToolCall = { id: string; name: string; args: string };
type StepResult = { content: string; toolCalls: ToolCall[] };
type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

export type ApprovalDecision = "yes" | "all" | "no";
export type OnApprove = (toolName: string, summary: string) => Promise<ApprovalDecision>;

function projectContext(): string {
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) {
      try {
        return `\n\nProject guide (${f}):\n${readFileSync(p, "utf8").slice(0, 8000)}`;
      } catch {
        /* ignore unreadable */
      }
    }
  }
  return "";
}

/** The repo map, as a system note. Kept OUT of the base prompt so it can be skipped on turns that
 *  have nothing to do with the code — it's ~1.5k tokens and would otherwise ride on every request. */
function brainNote(): string {
  try {
    const map = loadBrain();
    return map ? `Project map (file paths and their top-level symbols; use grep/codebase_search to go deeper):\n${map}` : "";
  } catch {
    return ""; // best-effort — never block a turn on it
  }
}

// Greetings and acknowledgements need no repo context. Deliberately narrow: anything that isn't
// clearly small talk still gets the map, so a real request is never left unoriented.
const SMALL_TALK = /^(hi|hey|hello|yo|sup|hola|namaste|thanks?|thank you|ty|ok|okay|k|cool|nice|great|awesome|got it|sounds good|good (?:morning|afternoon|evening|night)|bye|gn|lol|haha|ping|test|testing)[\s!.,?)*~-]*$/i;

/** True when the latest user turn is nothing but a greeting/acknowledgement. Such a turn needs no
 *  repo map and no tools at all — answering "hi" doesn't require the ability to edit files. Each
 *  request is assembled independently, so the very next message gets the full kit back. */
function isSmallTalk(messages: Msg[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const c = m.content;
    if (Array.isArray(c) && c.some((p) => typeof p === "object" && p && "type" in p && p.type === "image_url")) return false; // pasted an image
    const text = (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : "")).join(" ") : "").trim();
    return text.length <= 40 && SMALL_TALK.test(text);
  }
  return false; // no user turn yet
}

function systemPrompt(includeProject: boolean): string {
  return (
    [
      "You are ada, a minimal coding agent running in a terminal, in the spirit of pi, Codex, and Cursor.",
      `Working directory: ${process.cwd()}`,
      `Platform: ${process.platform}`,
      // The tool schemas already describe each tool — this only covers what they can't: when to pick one.
      "Explore with grep/glob/ls; use codebase_search when searching by meaning, not exact text. Read a file before editing; prefer edit_file over rewriting, apply_patch for multi-file changes; lsp_diagnostics after edits; ask_user only when blocked. Documents, decks and images can be generated on request.",
      "Call list_skills then use_skill before a specialized task.",
      "Call remember_fact when the user states a durable preference, convention or constraint ('always use X', 'we deploy via Y'). Not transient state, not secrets. Relevant memories are recalled automatically.",
      "Be concise. Don't narrate routine actions or pad with preamble. When you have enough information to act, act. Ask only when genuinely blocked or before destructive, irreversible actions.",
    ].join("\n") + (includeProject ? projectContext() : "")
  );
}

// Tools marked `lazy` carry big schemas that most turns never need. Since every schema is resent on
// every request, they're only advertised once the conversation asks for that kind of work — a plain
// "hi" shouldn't pay ~1k tokens for deck-building instructions. Each group has its OWN trigger:
// asking for a slide deck must not also drag in the notebook and browser schemas.
export const LAZY_GATES: { tools: string[]; intent: RegExp }[] = [
  {
    tools: ["generate_pptx", "generate_docx", "generate_image"],
    intent:
      /\b(deck|slides?|presentation|powerpoint|ppts?x?|keynote|docx|word (?:doc\w*|file)|document|report|write-?up|whitepaper|proposal|image|picture|png|jpe?g|illustration|artwork|diagram|mockup|thumbnail|cover art|infographic)\b/i,
  },
  {
    tools: ["create_page"],
    intent:
      /\b(html page|web ?page|landing page|one-?pager|dashboard|report|write-?up|presentation|comparison|summary page|visuali[sz]ation|infographic|share(?:able)? page)\b/i,
  },
  {
    tools: ["ui_ux_search"],
    intent:
      /\b(ui|ux|design|redesign|styling|style|look and feel|visual|layout|palette|colou?rs?|typography|fonts?|accessibility|a11y|wcag|animation|motion|component|dashboard|landing page|make it (?:look )?(?:better|beautiful|nicer))\b/i,
  },
  { tools: ["notebook_edit"], intent: /\b(notebooks?|jupyter|ipynb|colab|(?:code|markdown) cells?)\b/i },
  {
    tools: ["browser"],
    intent: /\b(browser|screenshots?|devtools|localhost|dev ?server|the (?:page|site|app) (?:looks?|renders?)|console\b|in chrome|open the (?:page|site|app)|preview)\b/i,
  },
];
// Gating is driven by the tool's own `lazy` flag; LAZY_GATES only says what unlocks each one. A
// lazy tool missing from the gates would go permanently invisible — test/lazy-tools.mjs asserts the
// two lists agree so that can't ship.

/** Routers wrap an upstream failure in their own envelope: OpenRouter's `message` is the useless
 *  "Provider returned error", while the reason the provider actually gave sits in
 *  `error.metadata.raw` and the provider's name in `error.metadata.provider_name`. Surfacing only
 *  the wrapper leaves a 400 undiagnosable, so pull the inner message up into the thrown error. */
export function explainApiError(e: unknown): unknown {
  const err = e as { message?: string; error?: { metadata?: { raw?: unknown; provider_name?: string } } };
  const meta = err?.error?.metadata;
  if (!meta?.raw && !meta?.provider_name) return e;
  let detail = typeof meta.raw === "string" ? meta.raw : JSON.stringify(meta.raw ?? "");
  try {
    const inner = JSON.parse(detail) as { error?: { message?: string }; message?: string };
    detail = inner?.error?.message ?? inner?.message ?? detail;
  } catch {
    /* raw wasn't JSON — show it as-is */
  }
  const who = meta.provider_name ? ` (provider: ${meta.provider_name})` : "";
  if (e instanceof Error) e.message = `${e.message}${who}: ${detail.slice(0, 400)}`;
  return e;
}

/** A streamed tool call arrives in fragments that have to be stitched back together. Providers do
 *  not agree on how: most number them with `index`, some omit it on continuation deltas, and some
 *  restart it at 0 for each call. Keying on `index` alone therefore concatenates two calls'
 *  arguments into `{...}{...}`, which is not JSON — and the NEXT request is rejected by strict
 *  providers ("Invalid tool arguments received … key must be a string"), long after the corruption
 *  happened. So: an `id` that differs from the slot's is a new call, whatever the index says. */
export function applyToolCallDelta(calls: ({ id: string; name: string; args: string } | undefined)[], tc: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): void {
  let i = typeof tc.index === "number" ? tc.index : Math.max(0, calls.length - 1);
  const slot = calls[i];
  if (tc.id && slot?.id && slot.id !== tc.id) i = calls.length; // same index, different call
  let entry = calls[i];
  if (!entry) {
    entry = { id: "", name: "", args: "" };
    calls[i] = entry;
  }
  if (tc.id) entry.id = tc.id;
  else if (!entry.id) entry.id = `call_${i}`; // some backends omit streamed ids — consumers key events on callId
  if (tc.function?.name) entry.name += tc.function.name;
  if (tc.function?.arguments) entry.args += tc.function.arguments;
}

/** Recent conversation text — matched over a window so a tool stays available for the whole task,
 *  not just the message that triggered it. */
function recentText(messages: Msg[]): string {
  const out: string[] = [];
  for (const m of messages.slice(-8)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = m.content;
    out.push(typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : "")).join(" ") : "");
  }
  return out.join("\n");
}

/** Which lazy tools this conversation has earned. */
function allowedLazyTools(messages: Msg[]): Set<string> {
  const text = recentText(messages);
  const allowed = new Set<string>();
  for (const g of LAZY_GATES) if (g.intent.test(text)) for (const n of g.tools) allowed.add(n);
  return allowed;
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

/** Model for sub-agents. A sub-agent gets a task the parent already narrowed and returns one string,
 *  so its whole tool loop is billable work that never enters the parent's context — the cheapest
 *  place in the system to trade capability for price. Opt-in: unset falls back to the parent's model,
 *  because defaulting to a provider the user has no key for would break spawn_agent outright. */
export function subagentModel(parentModel: string): string {
  return process.env.ADA_SUBAGENT_MODEL || loadSettings(isTrusted(process.cwd())).subagentModel || parentModel;
}

/** What a delegated run is for. The split is deliberate and asymmetric:
 *
 *  - `research` — exploring, reading, summarising, and planning. Cheap model. A weak answer here is
 *    visible to the parent, which can re-ask; the blast radius is one wasted subtask.
 *  - `build` — writing code. Stays on the model the user picked. Nobody proofreads generated code
 *    before it lands, so a weak model's mistakes survive until something breaks at runtime.
 *
 *  This is the opposite of the usual "frontier plans, cheap executes" advice. That advice optimises
 *  for token cost, and it's right about where the tokens are — but the tokens are in exploration,
 *  not in the code itself. Portfolio task, measured: 25,586 input tokens against 8,749 output. */
export type SpawnRole = "research" | "build";

const PLAN_NOTE =
  "PLAN MODE: do not write, edit, or run commands. Investigate with read-only tools if needed, then present a concise numbered plan and stop. The user will approve before you execute.";

// Delegation only pays when the planner hands down explicit instructions — a cheap worker follows
// literally, it doesn't infer. Bare one-line subtasks produced the two failures we measured: workers
// exploring the repo to work out what was meant (~174k input tokens for one subtask), and each
// deciding the shape independently ("create a portfolio website" came back as a deployment guide, a
// projects JSON, and an unrelated samples/ dir). So the planner decides FIRST and assigns files.
const DECOMPOSE_NOTE = [
  "Plan this as the lead engineer. You will NOT implement any of it — workers will, and they are cheaper models that follow instructions literally, cannot see each other's work, and cannot ask you questions.",
  "Make every design decision yourself now. Anything you leave unsaid will be decided differently by each worker.",
  "Split the work so each worker owns files no other worker touches.",
  "",
  "Output exactly this shape and nothing else:",
  "DESIGN: the decisions every worker must follow — stack, file layout, naming, shared interfaces, styling approach. A few lines.",
  "TASK <files it owns>: one complete instruction — what to build, what it must contain, what to leave alone. Assume the worker has no context beyond DESIGN and this line.",
  "TASK <files it owns>: ...",
  "",
  "2-5 TASK lines. Every file named in DESIGN must be owned by exactly one TASK.",
].join("\n");

// ---- orchestration: pluggable agent architectures over a shared Engine ----
// The Engine holds the harness primitives (streaming, tool-call recovery, compaction, approval,
// sessions). An Orchestrator is a Strategy that only decides WHEN to call those primitives, so a
// new agent architecture is one Orchestrator and zero changes to the engine.

/** The harness primitives a strategy composes. */
export interface Engine {
  step(opts?: { allowTools?: boolean; note?: string; model?: string }): Promise<StepResult | null>; // null = aborted
  /** The cheap model, for steps that think rather than write — pass it to step({ model }). */
  researchModel: string;
  runTools(calls: ToolCall[]): Promise<void>;
  say(s: string): void;
  interrupted(): void;
  /** Hand the model a turn's worth of new input mid-orchestration (worker results, "now execute
   *  the plan", a nudge). Deliberately role:"user", not "system": providers lift system messages
   *  out into a separate parameter, so a system-role append leaves the conversation ending on the
   *  assistant's own last message — which Claude rejects as an assistant prefill (400). */
  addUser(text: string): void;
  aborted(): boolean;
  drainSteer(): boolean;
  /** Delegate a subtask. `research` (the default) goes to the cheap sub-agent model — looking things
   *  up, reading, summarising, where a wrong answer is caught by the parent. `build` writes code and
   *  stays on the user's selected model: bad code isn't caught by anyone until it runs. */
  spawn(prompt: string, role?: SpawnRole): Promise<string>;
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
          e.addUser(
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
    e.addUser("Now execute the plan above, step by step, using your tools.");
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
    // Planning runs on the cheap model: it reads and decides, it doesn't write code.
    const plan = await e.step({ allowTools: false, note: DECOMPOSE_NOTE, model: e.researchModel });
    if (!plan) return;
    const lines = plan.content.split("\n");
    const isTask = (l: string) => /^\s*(?:[-*\d.)\s]*)TASK\b/i.test(l);
    // Everything that isn't a TASK line is the shared design — the one thing every worker sees, so
    // they can't each invent their own answer to the same question.
    const design = lines
      .filter((l) => !isTask(l))
      .join("\n")
      .replace(/^\s*DESIGN:\s*/im, "")
      .trim();
    const tasks = lines
      .filter(isTask)
      .map((l) => l.replace(/^\s*(?:[-*\d.)\s]*)TASK\s*/i, "").trim())
      .filter((t) => t.length > 8);
    // A planner that ignored the format still has to produce something — fall back to the old
    // line-per-subtask read rather than silently doing nothing.
    const finalTasks = tasks.length ? tasks : splitLines(plan.content).filter((t) => t.length > 8);
    if (!finalTasks.length) {
      e.say("\n");
      return;
    }
    e.say(`\n\x1b[2m• delegating ${finalTasks.length} subtasks${design ? " (shared design)" : ""}\x1b[0m\n`);
    const brief = (t: string) =>
      design
        ? `Shared design — follow it exactly, do not deviate or re-decide any of it:\n${design}\n\nYour assignment. You own ONLY the files named here; do not create or edit anything else, and do not duplicate another worker's work:\n${t}`
        : t;
    // Workers write code, so they run on the user's model, not the cheap one.
    const results = await Promise.all(finalTasks.map((t) => e.spawn(brief(t), "build")));
    e.addUser(`Subagent results:\n\n${results.map((r, i) => `### ${finalTasks[i]}\n${r}`).join("\n\n")}\n\nSynthesize the final answer for the user.`);
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
    case "generate_pptx":
      return { label: "pptx", detail: `${s(a.path)} (${Array.isArray(a.slides) ? a.slides.length : "?"} slides)` };
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
  if (name === "generate_pptx") return "write a PowerPoint (.pptx) file to disk";
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
async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  notice: (s: string) => void = (s) => process.stdout.write(s),
  max = 3,
): Promise<T> {
  let delay = 800;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || attempt >= max || !isTransient(e)) throw e;
      notice(`\x1b[2m[retrying in ${(delay / 1000).toFixed(1)}s — ${e instanceof Error ? e.message : e}]\x1b[0m\n`);
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
  private brain: string | null = null; // repo map, built lazily on the first turn that needs it
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0; // prompt tokens served from cache (billed ~0.1x)
  private cacheWriteTokens = 0; // prompt tokens written to cache (billed ~1.25x)
  private lastPromptTokens = 0; // the provider's real count for the last request — beats chars/4
  private subAgents = 0; // delegated runs, rolled up so a swarm's true cost is visible
  private subPromptTokens = 0;
  private subCompletionTokens = 0;
  private subCost = 0;
  private claimedPaths = new Set<string>(); // output files already owned by a worker this run
  /** Tokens keyed by the model that actually served them. A turn can override the model (planning
   *  runs cheap while the conversation stays on the user's pick), so one price for the whole agent
   *  would bill the cheap step at the expensive rate. */
  private byModel = new Map<string, { prompt: number; completion: number; cached: number; cacheWrite: number }>();
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

    if (this.contextTokens() > this.compactAt) await this.autoCompact("size threshold");
    let skillMsg: Msg | null = null;
    if (!ctrl?.delegated) {
      // Auto-recall: the few memories relevant to this input, injected transiently for this turn only.
      this.pendingMemory = recallBlock(input, !!this.project);
      // Orchestrate skills: when one clearly fits, apply it (inject its procedure into context so
      // even a weak model follows it, persisted across the tool loop). Otherwise, a soft hint.
      const fit = routeConfident(input);
      if (fit) {
        // Scoped to THIS request: it has to survive the tool loop, but a skill body is the largest of
        // the three injections and it applies to one task. Left in `messages` it would be re-sent on
        // every later turn, and `session.append` would restore it on --resume, forever. Removed in the
        // finally below; the router re-applies it next input if it still fits.
        skillMsg = { role: "system", content: `A skill fits this request: "${fit.name}". Follow its procedure for this task unless it clearly doesn't fit what was asked, in which case ignore it and proceed.\n\n${fit.body}` };
        this.messages.push(skillMsg);
        say(`\x1b[2m↳ skill: ${fit.name}\x1b[0m\n`);
      } else {
        this.pendingNote = suggestSkillNote(input);
      }
    }

    const engine = this.makeEngine(ctrl, say, interrupted, drainSteer);
    try {
      await (ORCHESTRATORS[this.strategy] ?? reAct).run(engine);
    } finally {
      if (skillMsg) {
        const i = this.messages.indexOf(skillMsg);
        if (i >= 0) this.messages.splice(i, 1);
      }
    }
    ctrl?.onEvent?.({ type: "done", text: this.lastAssistant, usage: this.usageReport(), context: this.contextTokens() });
    return this.lastAssistant;
  }

  // ---- Engine: the harness primitives an Orchestrator composes ----

  private makeEngine(ctrl: SendCtrl | undefined, say: (s: string) => void, interrupted: () => void, drainSteer: () => boolean): Engine {
    const signal = ctrl?.signal;
    return {
      step: (opts) => this.modelTurn(ctrl, say, interrupted, opts),
      researchModel: subagentModel(this.model),
      runTools: (calls) => this.execTools(calls, ctrl, say),
      say,
      interrupted,
      addUser: (text) => {
        const m: Msg = { role: "user", content: text };
        this.messages.push(m);
        this.session.append(m);
      },
      aborted: () => !!signal?.aborted,
      drainSteer,
      spawn: (prompt, role) => this.spawnSub(prompt, role),
      soleIntegration,
      readDocs: async (name) => readIntegrationDocs(name),
      writeSkills: async (drafts) => writeProjectSkills(drafts),
    };
  }

  /** Claim output paths for one worker. Single-threaded JS makes check-and-set atomic within a tick,
   *  so concurrent workers can't both win the same file. A collision means the planner assigned one
   *  file to two workers — a decomposition bug, so it's reported rather than silently resolved. */
  private claimPaths(paths: string[]): { taken: string[]; collided: string[] } {
    const taken: string[] = [];
    const collided: string[] = [];
    for (const p of paths) {
      if (this.claimedPaths.has(p)) collided.push(p);
      else {
        this.claimedPaths.add(p);
        taken.push(p);
      }
    }
    return { taken, collided };
  }

  /** A fresh, headless sub-agent (autoApprove, quiet). Returns its final text.
   *
   *  Runs in its own git worktree as a child process where possible — the tool layer resolves paths
   *  against the process-global cwd, so parallel in-process workers would all write into the parent's
   *  tree (observed: four stray files and a README edit from one swarm run). Falls back to in-process
   *  when the cwd isn't a git repo, so a subtask never fails purely for lack of isolation. */
  private async spawnSub(prompt: string, role: SpawnRole = "research"): Promise<string> {
    const model = role === "build" ? this.model : subagentModel(this.model);
    if (process.env.ADA_NO_SUBAGENTS !== "1") {
      try {
        const run = await runIsolatedWorker({
          cwd: process.cwd(),
          prompt,
          model,
          binPath: fileURLToPath(new URL("../../bin/ada.mjs", import.meta.url)),
          claim: (paths) => this.claimPaths(paths),
        });
        if (run) {
          this.subAgents++;
          const u = parseUsageLine(run.usage);
          this.subPromptTokens += u.promptTokens;
          this.subCompletionTokens += u.completionTokens;
          this.subCost += u.cost;
          const note = run.collided.length ? `\n\n[not applied — another worker already owns: ${run.collided.join(", ")}]` : "";
          return run.text + note;
        }
      } catch {
        /* isolation failed mid-run — fall through and do the work in-process rather than lose it */
      }
    }

    // Workers inherit the parent's project context. Counterintuitive for cost, but measured the
    // other way: blind workers spent ~174k input tokens groping around the repo to orient. The map
    // is ~1.5k and it replaces that search. Cheap models are exactly the ones that can't infer
    // layout from nothing — and they're now cheap enough that context is the affordable half.
    const sub = new Agent({ client: this.client, model, session: Session.create(), onApprove: this.onApprove, autoApprove: true, project: this.project });
    try {
      return await sub.send(prompt, { quiet: true, delegated: true });
    } finally {
      const u = sub.usageRaw(); // roll up even if the subtask threw — the tokens were still billed
      this.subAgents++;
      this.subPromptTokens += u.promptTokens;
      this.subCompletionTokens += u.completionTokens;
      this.subCost += u.cost ?? 0;
    }
  }

  /** One model turn: stream, collect content + tool calls (recovering leaked ones), push the
   *  assistant message. Returns null if interrupted. Retries once on context overflow. */
  private async modelTurn(ctrl: SendCtrl | undefined, say: (s: string) => void, interrupted: () => void, opts?: { allowTools?: boolean; note?: string; model?: string }): Promise<StepResult | null> {
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
    // Send only what this turn can actually use. Answering "hi" needs no repo map and no tools, so
    // it costs the base prompt alone; the next message is assembled fresh and gets the full kit.
    const smallTalk = isSmallTalk(this.messages);
    // Re-gated per turn, deliberately. Making unlocked tools sticky would keep the cached prefix
    // stable, but that only pays off when the transcript is actually cached — and it isn't on the
    // OpenAI-compatible path, which never sends cache_control. Measured: sticky cost +15% input per
    // turn on a deck task (which trips the document gates) for no cache benefit.
    // ponytail: revisit if cache_control lands in openai-compat.ts — then sticky is the better trade.
    const allowed = smallTalk ? new Set<string>() : allowedLazyTools(this.messages);
    const lazyNames = new Set(tools.filter((t) => t.lazy).map((t) => t.name));
    const apiTools = smallTalk
      ? [] // no file edits, shell or search needed to say hello back
      : this.apiTools.filter((t) => !("function" in t) || !lazyNames.has(t.function.name) || allowed.has(t.function.name));

    const extras: string[] = [];
    if (this.project && !smallTalk) {
      this.brain ??= brainNote(); // built once per session, reused every request
      if (this.brain) extras.push(this.brain);
    }
    if (note) extras.push(note);
    const sendMessages: Msg[] = extras.length ? [...this.messages, { role: "system", content: extras.join("\n\n") }] : this.messages;

    let overflowRetried = false;
    for (;;) {
      const create = () =>
        this.client.chat.completions.create(
          {
            // A step can override the model: planning/decomposition runs on the cheap one while the
            // conversation itself stays on the user's pick. Same transcript either way — the wire
            // format is identical, so the messages array doesn't care which model reads it.
            model: opts?.model ?? this.model,
            messages: sendMessages,
            // Omit the field entirely when there's nothing to advertise — several providers reject
            // an empty `tools` array outright.
            ...(apiTools.length ? { tools: apiTools, tool_choice: opts?.allowTools === false ? ("none" as const) : ("auto" as const) } : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...(this.reasoning ? { reasoning_effort: this.reasoning } : {}),
          },
          signal ? { signal } : undefined,
        );
      let stream: Awaited<ReturnType<typeof create>>;
      try {
        stream = await withRetry(create, signal, say);
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
        throw explainApiError(e);
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
            this.lastPromptTokens = chunk.usage.prompt_tokens ?? this.lastPromptTokens;
            const d = chunk.usage.prompt_tokens_details as { cached_tokens?: number; cache_creation_tokens?: number } | undefined;
            this.cachedTokens += d?.cached_tokens ?? 0;
            this.cacheWriteTokens += d?.cache_creation_tokens ?? 0;
            const key = opts?.model ?? this.model;
            const b = this.byModel.get(key) ?? { prompt: 0, completion: 0, cached: 0, cacheWrite: 0 };
            b.prompt += chunk.usage.prompt_tokens ?? 0;
            b.completion += chunk.usage.completion_tokens ?? 0;
            b.cached += d?.cached_tokens ?? 0;
            b.cacheWrite += d?.cache_creation_tokens ?? 0;
            this.byModel.set(key, b);
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
          for (const tc of delta?.tool_calls ?? []) applyToolCallDelta(calls, tc);
        }
      } catch (e) {
        say(md.end());
        if (signal?.aborted) {
          interrupted();
          return null;
        }
        throw explainApiError(e);
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
      // ponytail: always a one-line ⎿ summary — the model sees the full output; the human chat stays clean
      const first = (r.display ?? r.output ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim() ?? "";
      const line = first.length > 80 ? `${first.slice(0, 79)}…` : first;
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

  /** Real context size. The provider's own count for the last request when we have one — it lands a
   *  turn stale (it predates the newest user message) but is far closer than chars/4, and it costs
   *  nothing. Falls back to the estimate before the first response. */
  contextTokens(): number {
    return this.lastPromptTokens || estimateTokens(this.messages);
  }

  /** This agent's own counters, so a parent can roll a finished sub-agent's spend into its own.
   *  Sub-agents run on a different model at a different price, so the parent aggregates COST, not
   *  tokens — adding a worker's tokens to the planner's would price them at the planner's rate. */
  usageRaw(): { model: string; promptTokens: number; completionTokens: number; cost: number | null } {
    return { model: this.model, promptTokens: this.promptTokens, completionTokens: this.completionTokens, cost: this.ownCost() };
  }

  /** Cost of this agent's own traffic. Cache reads bill ~0.1x and writes ~1.25x — pricing every
   *  prompt token at the full input rate over-reports by exactly the cache's savings. */
  private ownCost(): number | null {
    // Priced per model that served the tokens, not per agent — see byModel.
    const buckets = this.byModel.size ? [...this.byModel.entries()] : [[this.model, { prompt: this.promptTokens, completion: this.completionTokens, cached: this.cachedTokens, cacheWrite: this.cacheWriteTokens }] as const];
    let total = 0;
    let priced = false;
    for (const [model, b] of buckets) {
      const p = priceFor(model);
      if (!p) continue; // unknown model: leave it out rather than guess at the wrong rate
      priced = true;
      const fresh = Math.max(0, b.prompt - b.cached - b.cacheWrite);
      total += (fresh / 1e6) * p[0] + (b.cached / 1e6) * p[0] * 0.1 + (b.cacheWrite / 1e6) * p[0] * 1.25 + (b.completion / 1e6) * p[1];
    }
    return priced ? total : null;
  }

  usageReport(): string {
    const own = this.ownCost();
    const cache = this.cachedTokens ? ` · cache ${Math.round((this.cachedTokens / this.promptTokens) * 100)}% hit` : "";
    const head = `tokens: ${this.promptTokens} in / ${this.completionTokens} out${cache}`;
    // Delegated work is billed too. Reporting only the planner's tokens makes a swarm run look
    // almost free — the workers burn most of the tokens and none of them land in this transcript.
    if (this.subAgents) {
      const total = own !== null && this.subCost !== null ? own + this.subCost : null;
      const worker = `${this.subAgents} subagent${this.subAgents > 1 ? "s" : ""}: ${this.subPromptTokens} in / ${this.subCompletionTokens} out · ~$${(this.subCost ?? 0).toFixed(4)}`;
      return `${head} · ~$${(own ?? 0).toFixed(4)} planner\n${worker}${total !== null ? `\ntotal: ~$${total.toFixed(4)}` : ""}`;
    }
    return `${head}${own !== null ? ` · ~$${own.toFixed(4)}` : " · (no price table for this model)"}`;
  }

  private async autoCompact(reason: string): Promise<void> {
    const result = await compact(this.client, this.model, this.messages);
    if (result) {
      this.messages = result.messages;
      process.stdout.write(`\x1b[2m[compacted earlier context — ${reason}]\x1b[0m\n`);
    }
  }
}
