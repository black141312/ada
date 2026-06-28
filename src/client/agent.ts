// The agentic loop. Talks ONLY to the ada backend via the OpenAI SDK; the backend
// routes to the real provider. Streams text, runs tool calls, persists every message.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type OpenAI from "openai";
import { compact, estimateTokens, isContextOverflowError } from "./compaction.ts";
import { MarkdownStreamer } from "./render.ts";
import { type Tool, type ToolResult, isDestructive, toolByName, tools } from "./tools.ts";
import { afterTool, beforeTool, transformInput } from "./hooks.ts";
import { Session } from "./session.ts";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
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

function systemPrompt(includeProject: boolean): string {
  return (
    [
      "You are ada, a minimal coding agent running in a terminal, in the spirit of pi, Codex, and Cursor.",
      `Working directory: ${process.cwd()}`,
      `Platform: ${process.platform}`,
      "Tools: read_file, write_file, edit_file, bash, ls, grep, glob. Use grep/glob/ls to explore the codebase; read a file before editing it; prefer edit_file for changes to existing files.",
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
  for (const k of Object.keys(PRICES)) if (model.includes(k)) return PRICES[k]!;
  return null;
}

function summarize(args: unknown): string {
  const s = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
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
    this.messages = [{ role: "system", content: systemPrompt(opts.project ?? true) }, ...(opts.history ?? [])];
  }

  setModel(m: string): void {
    this.model = m;
  }

  setOnApprove(fn: OnApprove): void {
    this.onApprove = fn;
  }

  setReasoning(r: "low" | "medium" | "high" | undefined): void {
    this.reasoning = r;
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

  async send(
    input: string,
    ctrl?: { signal?: AbortSignal; steer?: string[]; quiet?: boolean; images?: string[]; onReplyStart?: () => void },
  ): Promise<string> {
    const signal = ctrl?.signal;
    let replyStarted = false;
    const say = (s: string): void => {
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

    let overflowRetried = false;
    for (;;) {
      if (signal?.aborted) {
        interrupted();
        return this.lastAssistant;
      }
      const create = () =>
        this.client.chat.completions.create(
          {
            model: this.model,
            messages: this.planMode ? [...this.messages, { role: "system", content: PLAN_NOTE }] : this.messages,
            tools: this.apiTools,
            tool_choice: "auto",
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
          return this.lastAssistant;
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
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      } catch (e) {
        say(md.end());
        if (signal?.aborted) {
          // drop the partial assistant message; the user turn stands on its own
          interrupted();
          return this.lastAssistant;
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

      if (!toolCalls.length) {
        say("\n");
        if (drainSteer()) continue; // user steered after the answer → keep going
        return this.lastAssistant;
      }

      const printCall = (name: string, args: Record<string, unknown>): void => {
        say(`\n\x1b[2m• ${name} ${summarize(args)}\x1b[0m\n`);
      };
      const printResult = (r: ToolResult): void => {
        if (r.display) say(`${r.display}\n`);
        else if (r.isError) say(`\x1b[31m  ${r.output.split("\n")[0]}\x1b[0m\n`);
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
          printCall(c.name, args);
          results[i] = { output: `Unknown tool: ${c.name}`, isError: true };
          continue;
        }
        if (!tool.needsApproval) {
          parallel.push(i);
          continue;
        }
        // gated tool → sequential (so approval prompts and same-file writes don't race)
        printCall(c.name, args);
        if (this.planMode) {
          results[i] = { output: "Plan mode: not executing — finish the plan; the user approves with /run." };
          printResult(results[i]!);
          continue;
        }
        const forceConfirm = c.name === "bash" && isDestructive(String(args.command ?? ""));
        if (this.autoApprove && !forceConfirm) {
          results[i] = await runTool(tool, c.name, args);
        } else {
          const decision = await this.onApprove(c.name, forceConfirm ? `⚠ destructive: ${summarize(args)}` : summarize(args));
          if (decision === "all") {
            this.autoApprove = true;
            results[i] = await runTool(tool, c.name, args);
          } else if (decision === "no") {
            results[i] = { output: "Denied by user." };
          } else {
            results[i] = await runTool(tool, c.name, args);
          }
        }
        printResult(results[i]!);
      }
      await Promise.all(
        parallel.map(async (i) => {
          const c = toolCalls[i]!;
          const args = argsOf(c.args);
          printCall(c.name, args);
          results[i] = await runTool(toolByName.get(c.name)!, c.name, args);
          printResult(results[i]!);
        }),
      );
      for (let i = 0; i < toolCalls.length; i++) {
        const toolMsg: Msg = { role: "tool", tool_call_id: toolCalls[i]!.id, content: results[i]!.output };
        this.messages.push(toolMsg);
        this.session.append(toolMsg);
      }

      if (signal?.aborted) {
        interrupted();
        return this.lastAssistant;
      }
      drainSteer(); // inject any steered messages before the next turn
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
