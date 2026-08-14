// Self-awareness and agent-society tools — the layer prime-agent has and ada lacked.
//
// One registry of LIVE agent runs (the main chat and every sub-agent alike). Each entry holds the
// run's steer queue — the same array the agent already drains between steps — so "messaging" an
// agent is nothing more than pushing into it. On top of that registry: list/peek/message tools,
// a per-agent goal, context introspection, self-scheduled heartbeats, and standing notes the
// system prompt reads back next session.
//
// ponytail: everything here is process-local. Agents in another `ada` process (an isolated worker
// child, another terminal) are invisible; a cross-process registry file is the upgrade path.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type AgentHandle, registerTool } from "./tools.ts";

export interface LiveRun {
  id: string;
  label: string; // first line of the task, for humans
  started: number;
  steer: string[]; // drained by the agent between steps — the message mailbox
  agent: AgentHandle;
  /** The serve chat this run belongs to ("" for the REPL/CLI) — the delivery address for notify(). */
  sessionKey: string;
  heartbeats: { id: number; every: number; instruction: string; timer: ReturnType<typeof setInterval> }[];
}

const runs = new Map<string, LiveRun>();
let seq = 0;

/** Notifications for sessions with no run in flight, delivered when their next turn registers.
 *  Capped per session — a notification is a nudge, not a log. */
const pending = new Map<string, string[]>();
const PENDING_CAP = 10;

/** Called by Agent.send() when a turn starts. Returns the run id to hand back to endRun. */
export function registerRun(label: string, steer: string[], agent: AgentHandle, sessionId?: string): string {
  const id = `a${++seq}`;
  const sessionKey = sessionId ?? "";
  runs.set(id, { id, label: label.split("\n")[0]!.slice(0, 80), started: Date.now(), steer, agent, sessionKey, heartbeats: [] });
  const waiting = pending.get(sessionKey);
  if (waiting?.length) {
    steer.push(...waiting);
    pending.delete(sessionKey);
  }
  return id;
}

/** Deliver a harness notification (a finished job, a watcher firing) to a session's agent: into a
 *  live run's steer queue if one is in flight, else parked until the session's next turn. When a
 *  chat has several live runs (main turn + sub-agents share a sessionId), the oldest gets it —
 *  that is the main turn, registered before any child it spawned. */
export function notify(sessionId: string | undefined, text: string): void {
  const key = sessionId ?? "";
  const live = [...runs.values()].filter((r) => r.sessionKey === key).sort((a, b) => a.started - b.started)[0];
  if (live) {
    live.steer.push(text);
    return;
  }
  const q = pending.get(key) ?? [];
  q.push(text);
  pending.set(key, q.slice(-PENDING_CAP));
}

/** Called when the turn ends. Clears heartbeat timers so nothing ticks into a dead queue. */
export function endRun(id: string): void {
  const r = runs.get(id);
  if (!r) return;
  for (const h of r.heartbeats) clearInterval(h.timer);
  runs.delete(id);
}

export function liveRuns(): LiveRun[] {
  return [...runs.values()];
}

// ---- goals: one persistent objective per agent, keyed on the agent itself ----
// WeakMap so a finished agent takes its goal with it. ponytail: process-lifetime only — a goal
// does not survive a restart; persist to .ada/goal.json if that ever matters.

interface Goal {
  objective: string;
  status: "active" | "done";
  created: number;
  tokenStart: number;
  tokenBudget?: number;
}
const goals = new WeakMap<AgentHandle, Goal>();

// ---- standing notes: refine-lite ----
// The agent leaves itself one-line lessons; systemPrompt() reads the tail back every session.

const notesPath = (): string => resolve(process.cwd(), ".ada", "notes.md");

export function readNotes(max = 2000): string {
  try {
    return readFileSync(notesPath(), "utf8").trim().slice(-max);
  } catch {
    return "";
  }
}

// ---- the tools ----

const str = (v: unknown): string => (v == null ? "" : String(v));

registerTool({
  name: "list_agents",
  description: "List agent runs live in this process right now — the main chat and any sub-agents — with id, task, age and context size. Use peek_agent for detail, send_agent_message to talk to one.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  needsApproval: false,
  async run(_args, ctx) {
    const rows = liveRuns().map((r) => `${r.id}${r.id === ctx?.runId ? " (you)" : ""} [${Math.round((Date.now() - r.started) / 1000)}s] ~${r.agent.contextTokens()} tokens — ${r.label}`);
    return { output: rows.join("\n") || "(no live agent runs)" };
  },
});

registerTool({
  name: "peek_agent",
  description: "Read-only look at one live agent run: its task, age, context size, token usage, and the last thing it said. Get ids from list_agents.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Run id from list_agents, e.g. a2." } }, required: ["id"], additionalProperties: false },
  needsApproval: false,
  async run(args) {
    const r = runs.get(str(args.id));
    if (!r) return { output: `No live run "${str(args.id)}". Live: ${[...runs.keys()].join(", ") || "(none)"}`, isError: true };
    const u = r.agent.usageRaw();
    const last = r.agent.lastText();
    return {
      output: [
        `${r.id} — ${r.label}`,
        `running ${Math.round((Date.now() - r.started) / 1000)}s · model ${u.model} · ~${r.agent.contextTokens()} context tokens · ${u.promptTokens} in / ${u.completionTokens} out`,
        last ? `last said: ${last.slice(0, 600)}` : "(nothing said yet)",
      ].join("\n"),
    };
  },
});

registerTool({
  name: "send_agent_message",
  description: "Send a short message to another live agent run (from list_agents). It is delivered into that agent's queue and read between its steps — steering, extra context, or a stop request in plain words.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Target run id from list_agents." }, message: { type: "string", description: "The message. Be brief and specific." } },
    required: ["id", "message"],
    additionalProperties: false,
  },
  needsApproval: false,
  async run(args, ctx) {
    const r = runs.get(str(args.id));
    if (!r) return { output: `No live run "${str(args.id)}". Live: ${[...runs.keys()].join(", ") || "(none)"}`, isError: true };
    if (r.id === ctx?.runId) return { output: "That's you — no need to message yourself.", isError: true };
    r.steer.push(`[message from agent ${ctx?.runId ?? "?"}] ${str(args.message)}`);
    return { output: `Delivered to ${r.id}; it reads the message after its current step.` };
  },
});

registerTool({
  name: "goal",
  description: "Your persistent objective for a long run. action=set records it (optionally with a token budget to watch), action=get reports objective + tokens spent since, action=done closes it. Only set a goal for genuinely long multi-step work.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "get", "done"] },
      objective: { type: "string", description: "For set: the objective, one or two sentences." },
      token_budget: { type: "number", description: "For set, optional: soft budget of prompt tokens for this goal." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  needsApproval: false,
  async run(args, ctx) {
    const agent = ctx?.agent;
    if (!agent) return { output: "No agent context.", isError: true };
    const action = str(args.action);
    if (action === "set") {
      const objective = str(args.objective).trim();
      if (!objective) return { output: "goal set needs an objective.", isError: true };
      goals.set(agent, { objective, status: "active", created: Date.now(), tokenStart: agent.usageRaw().promptTokens, tokenBudget: typeof args.token_budget === "number" ? args.token_budget : undefined });
      return { output: `Goal set: ${objective}` };
    }
    const g = goals.get(agent);
    if (!g) return { output: "No goal set." };
    if (action === "done") {
      g.status = "done";
      return { output: `Goal closed: ${g.objective}` };
    }
    const spent = agent.usageRaw().promptTokens - g.tokenStart;
    const budget = g.tokenBudget ? ` of ${g.tokenBudget} budget` : "";
    return { output: `Goal (${g.status}): ${g.objective}\nset ${Math.round((Date.now() - g.created) / 60000)}m ago · ${spent} prompt tokens spent on it${budget}` };
  },
});

registerTool({
  name: "context_status",
  description: "How full your own context window is: current tokens, the auto-compact threshold, and percent used. Check before starting something long; call compact_now if you're close.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  needsApproval: false,
  async run(_args, ctx) {
    const agent = ctx?.agent;
    if (!agent) return { output: "No agent context.", isError: true };
    const used = agent.contextTokens();
    const limit = agent.compactLimit();
    return { output: `~${used} of ${limit} tokens before auto-compact (${Math.round((used / limit) * 100)}%).` };
  },
});

registerTool({
  name: "compact_now",
  description: "Summarize and shrink your own earlier context immediately, instead of waiting for the automatic threshold. Use when context_status is high and important work is still ahead.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  needsApproval: false,
  async run(_args, ctx) {
    const agent = ctx?.agent;
    if (!agent) return { output: "No agent context.", isError: true };
    return { output: await agent.compactNow() };
  },
});

registerTool({
  name: "heartbeat",
  description: "Recurring self-reminder during a long run: action=create injects the instruction into your own queue every N seconds while this run is live; list shows them; cancel stops one. They end with the run.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "cancel"] },
      instruction: { type: "string", description: "For create: what to be reminded of." },
      every_seconds: { type: "number", description: "For create: interval, min 15." },
      id: { type: "number", description: "For cancel: heartbeat id from list." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  needsApproval: false,
  async run(args, ctx) {
    const r = ctx?.runId ? runs.get(ctx.runId) : undefined;
    if (!r) return { output: "No live run context.", isError: true };
    const action = str(args.action);
    if (action === "create") {
      const instruction = str(args.instruction).trim();
      const every = Math.max(15, Number(args.every_seconds) || 60);
      if (!instruction) return { output: "heartbeat create needs an instruction.", isError: true };
      if (r.heartbeats.length >= 3) return { output: "Max 3 heartbeats per run.", isError: true };
      const id = r.heartbeats.length + 1;
      const timer = setInterval(() => r.steer.push(`[heartbeat ${id}] ${instruction}`), every * 1000);
      timer.unref?.(); // never keep the process alive for a reminder
      r.heartbeats.push({ id, every, instruction, timer });
      return { output: `Heartbeat ${id} set: every ${every}s — "${instruction}". Active while this run lives.` };
    }
    if (action === "cancel") {
      const id = Number(args.id);
      const i = r.heartbeats.findIndex((h) => h.id === id);
      if (i < 0) return { output: `No heartbeat ${id}.`, isError: true };
      clearInterval(r.heartbeats[i]!.timer);
      r.heartbeats.splice(i, 1);
      return { output: `Heartbeat ${id} cancelled.` };
    }
    return { output: r.heartbeats.map((h) => `${h.id}: every ${h.every}s — ${h.instruction}`).join("\n") || "(no heartbeats)" };
  },
});

registerTool({
  name: "refine_note",
  description: "Leave yourself a standing one-line note that future sessions read at startup (.ada/notes.md) — a lesson about THIS project's workflow that isn't a user preference (those go to remember_fact). E.g. 'build breaks unless run from repo root'.",
  parameters: { type: "object", properties: { note: { type: "string", description: "One line, imperative, specific." } }, required: ["note"], additionalProperties: false },
  needsApproval: false,
  async run(args) {
    const note = str(args.note).trim().replace(/\s+/g, " ");
    if (!note) return { output: "refine_note needs a note.", isError: true };
    const p = notesPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `- ${note}\n`);
    return { output: `Noted. Future sessions will see it.` };
  },
});
