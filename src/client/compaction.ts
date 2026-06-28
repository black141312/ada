// Context management (pi-style compaction). When the transcript grows large, summarize the
// older turns into one compact summary and keep the recent ones, so a session can run forever.
// The summary is produced by the same model via the backend. Token sizing is a chars/4 estimate
// (no tokenizer dependency) — accurate enough to decide *when* to compact.

import type OpenAI from "openai";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Cap on the text fed to the summarizer, so the summary call itself can't overflow the context.
const SUMMARY_INPUT_MAX = 30_000;

export function estimateTokens(messages: Msg[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m).length;
  return Math.ceil(chars / 4); // ponytail: chars/4 heuristic, not a real tokenizer — fine for a threshold
}

export function isContextOverflowError(e: unknown): boolean {
  const s = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /context|max(imum)?[ _-]*tokens?|too long|exceeds|context[_ ]length|reduce the length|prompt is too/.test(s);
}

/** Pure: split messages into { system, toSummarize, tail } at a clean turn boundary, or null when
 *  there isn't enough to compact. `tail` always starts at a user message, so a tool_call/tool_result
 *  pair is never split across the cut. */
export function planCut(
  messages: Msg[],
  keepLast = 6,
): { system: Msg | null; toSummarize: Msg[]; tail: Msg[] } | null {
  const system = messages[0]?.role === "system" ? messages[0]! : null;
  const body = system ? messages.slice(1) : messages;
  if (body.length <= keepLast + 1) return null;

  let cut = body.length - keepLast;
  while (cut > 0 && body[cut]?.role !== "user") cut--; // snap the tail start back to a user message
  if (cut <= 0) return null;

  return { system, toSummarize: body.slice(0, cut), tail: body.slice(cut) };
}

function serialize(messages: Msg[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    let text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? "(non-text content)" : "";
    const calls = (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
    if (calls) text += calls.map((c) => `\n[calls ${c.function?.name}(${c.function?.arguments ?? ""})]`).join("");
    parts.push(`${m.role}: ${text}`.trim());
  }
  let out = parts.join("\n\n");
  if (out.length > SUMMARY_INPUT_MAX) out = `[…older messages omitted…]\n\n${out.slice(-SUMMARY_INPUT_MAX)}`;
  return out;
}

/** Summarize the older messages and return a compacted transcript: [system, summary, ...tail]. */
export async function compact(
  client: OpenAI,
  model: string,
  messages: Msg[],
  keepLast = 6,
): Promise<{ messages: Msg[]; summary: string } | null> {
  const plan = planCut(messages, keepLast);
  if (!plan) return null;

  // Stream the summary (works for every adapter — anthropic always streams, openai-compat too).
  const stream = await client.chat.completions.create({
    model,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "You compress a coding agent's conversation into a concise summary so the task can continue. " +
          "Preserve: the user's goal, key decisions, files created/edited (with paths), important command " +
          "results, and remaining TODOs. Be terse and factual. Output only the summary.",
      },
      { role: "user", content: `${serialize(plan.toSummarize)}\n\n---\nSummarize the conversation above.` },
    ],
  });
  let summary = "";
  for await (const chunk of stream) summary += chunk.choices[0]?.delta?.content ?? "";
  summary = summary.trim() || "(summary unavailable)";

  const summaryMsg: Msg = { role: "user", content: `[Summary of earlier conversation in this session]\n${summary}` };
  return { messages: [...(plan.system ? [plan.system] : []), summaryMsg, ...plan.tail], summary };
}
