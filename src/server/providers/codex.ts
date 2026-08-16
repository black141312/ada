// ChatGPT (Codex) adapter — the third wire format, alongside OpenAI Chat Completions and
// Anthropic Messages.
//
// A ChatGPT Plus/Pro subscription doesn't reach the normal OpenAI API. It reaches
// chatgpt.com/backend-api/codex/responses, which speaks the OpenAI *Responses* API: a different
// request shape (`input` items, not `messages`; `instructions`, not a system message) and a
// different event stream (typed `response.*` events, not `chat.completion.chunk`). So it gets its
// own adapter, and translates both directions — in stays OpenAI-shaped, out stays OpenAI-shaped,
// and the client never learns any of this happened.
//
// Auth is the subscription OAuth token (see subscription-oauth.ts) plus the account id from its JWT.
// There is no API-key path here on purpose: with a key you want plain `openai`, which is cheaper to
// reason about and already works.

import { PROVIDERS } from "../config.ts";
import { endStream, SSE_HEADERS, writeChunk } from "../sse.ts";
import type { Adapter, ChatRequest } from "./adapter.ts";
import { chatgptAccountId, chatgptPlan, freshToken, planLacksCodex } from "./subscription-oauth.ts";

type OAIMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

type Item = Record<string, unknown>;

/** OpenAI `messages[]` → Responses `{ instructions, input[] }`. */
export function toResponsesInput(messages: OAIMessage[]): { instructions: string; input: Item[] } {
  const instructions: string[] = [];
  const input: Item[] = [];

  for (const m of messages) {
    const role = m.role ?? "user";

    if (role === "system" || role === "developer") {
      // Responses has no system item — the whole system prompt is one top-level field.
      if (typeof m.content === "string") instructions.push(m.content);
      else if (Array.isArray(m.content)) instructions.push((m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(""));
      continue;
    }

    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: String(m.content ?? "") });
      continue;
    }

    if (role === "assistant") {
      if (typeof m.content === "string" && m.content) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const tc of m.tool_calls ?? []) {
        // call_id, not id: Responses matches a call to its output on call_id, and a mismatch here
        // makes the model re-issue the same tool call forever.
        input.push({ type: "function_call", call_id: tc.id ?? "", name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "{}" });
      }
      continue;
    }

    // user
    if (Array.isArray(m.content)) {
      const parts = (m.content as Array<Record<string, unknown>>).map((p) =>
        p.type === "image_url"
          ? { type: "input_image", image_url: String((p.image_url as { url?: string })?.url ?? "") }
          : { type: "input_text", text: String(p.text ?? "") },
      );
      input.push({ type: "message", role: "user", content: parts });
    } else {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: String(m.content ?? "") }] });
    }
  }

  return { instructions: instructions.join("\n\n"), input };
}

/** OpenAI `tools[]` (Chat Completions shape) → Responses tool shape (flat, no `function` wrapper). */
export function toResponsesTools(tools: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>): Item[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function?.name ?? "",
    description: t.function?.description ?? "",
    parameters: t.function?.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

export function buildCodexBody(body: Record<string, unknown>): Record<string, unknown> {
  const { instructions, input } = toResponsesInput((body.messages as OAIMessage[]) ?? []);
  const tools = (body.tools as Array<{ function?: { name?: string } }>) ?? [];
  const effort = body.reasoning_effort as string | undefined;

  return {
    model: String(body.model ?? "").replace(/^chatgpt\//, ""),
    // The endpoint rejects store:true outright — this transcript is ours to keep, not theirs.
    store: false,
    stream: true,
    instructions: instructions || "You are a helpful assistant.",
    input,
    ...(tools.length ? { tools: toResponsesTools(tools), tool_choice: "auto", parallel_tool_calls: true } : {}),
    ...(effort && effort !== "none" ? { reasoning: { effort, summary: "auto" } } : {}),
    // Cache affinity: same key → same backend prefix cache, which is most of the win on a tool loop.
    ...(typeof body.user === "string" ? { prompt_cache_key: body.user } : {}),
  };
}

/** Parse an SSE byte stream into `{event, data}` records. */
async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Records are separated by a blank line; a trailing partial record stays in `buf` for the
    // next read. Splitting on the match length (not a fixed 2) keeps CRLF streams intact.
    for (;;) {
      const sep = /\r?\n\r?\n/.exec(buf);
      if (!sep) break;
      const raw = buf.slice(0, sep.index);
      buf = buf.slice(sep.index + sep[0].length);
      let event = "";
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

export const codexAdapter: Adapter = {
  async chat({ body, res }: ChatRequest): Promise<void> {
    const id = `chatcmpl-${Math.random().toString(16).slice(2, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = String(body.model ?? "");
    const chunk = (delta: Record<string, unknown>, finish: string | null = null): void =>
      writeChunk(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

    const token = await freshToken("chatgpt");
    if (!token) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not signed in to ChatGPT — run `ada login chatgpt`" } }));
      return;
    }

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort(); // client left → stop generating (and paying for) tokens
    });

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${PROVIDERS.chatgpt.baseURL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": chatgptAccountId(token),
          "content-type": "application/json",
          accept: "text/event-stream",
          "OpenAI-Beta": "responses=experimental",
          originator: "ada",
          ...(typeof body.user === "string" ? { session_id: body.user } : {}),
        },
        body: JSON.stringify(buildCodexBody(body)),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) return void res.end();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `could not reach ChatGPT: ${e instanceof Error ? e.message : String(e)}` } }));
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      // On a free plan every model id is refused with a message about the *model*, which sends
      // people hunting through model names. The plan is in the token — say so instead.
      const plan = chatgptPlan(token);
      const message =
        upstream.status === 400 && planLacksCodex(plan) && /not supported when using Codex/.test(text)
          ? `this ChatGPT account is on the ${plan} plan, which can't use Codex — the model id is not the problem. Upgrade to Plus/Pro, or set OPENAI_API_KEY and use an \`openai\` model instead.`
          : upstream.status === 401
            ? "ChatGPT rejected the session — run `ada login chatgpt` again"
            : "";
      res.writeHead(upstream.status || 502, { "content-type": "application/json" });
      res.end(message ? JSON.stringify({ error: { message } }) : text || JSON.stringify({ error: { message: `ChatGPT upstream error ${upstream.status}` } }));
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    chunk({ role: "assistant" });

    let finish = "stop";
    let toolIndex = -1;
    const seenCalls = new Map<string, number>(); // item_id → tool_calls index
    let usage: Record<string, number> | null = null;

    try {
      for await (const { data } of sseEvents(upstream.body)) {
        if (data === "[DONE]") break;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue; // keep-alive or a frame we don't model — not worth killing the turn over
        }
        const type = String(ev.type ?? "");

        if (type === "response.output_text.delta") {
          chunk({ content: String(ev.delta ?? "") });
        } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
          // The client renders this separately and never folds it into the answer text.
          chunk({ reasoning_content: String(ev.delta ?? "") });
        } else if (type === "response.output_item.added") {
          const item = (ev.item ?? {}) as { type?: string; id?: string; call_id?: string; name?: string };
          if (item.type === "function_call") {
            toolIndex++;
            seenCalls.set(String(item.id ?? item.call_id ?? toolIndex), toolIndex);
            finish = "tool_calls";
            chunk({ tool_calls: [{ index: toolIndex, id: item.call_id ?? item.id, type: "function", function: { name: item.name ?? "", arguments: "" } }] });
          }
        } else if (type === "response.function_call_arguments.delta") {
          const idx = seenCalls.get(String(ev.item_id ?? "")) ?? toolIndex;
          if (idx >= 0) chunk({ tool_calls: [{ index: idx, function: { arguments: String(ev.delta ?? "") } }] });
        } else if (type === "response.completed") {
          const u = ((ev.response as { usage?: Record<string, unknown> })?.usage ?? {}) as Record<string, unknown>;
          const cached = Number((u.input_tokens_details as { cached_tokens?: number })?.cached_tokens ?? 0);
          usage = {
            prompt_tokens: Number(u.input_tokens ?? 0),
            completion_tokens: Number(u.output_tokens ?? 0),
            total_tokens: Number(u.total_tokens ?? 0) || Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0),
            cached,
          };
        } else if (type === "response.failed" || type === "error") {
          const msg = ((ev.response as { error?: { message?: string } })?.error?.message ?? (ev as { message?: string }).message) || "ChatGPT stream failed";
          chunk({ content: `\n[backend: chatgpt error: ${msg}]` });
        }
      }

      chunk({}, finish);
      if (usage) {
        // Emitted in the OpenAI shape so the backend's metering (index.ts tees this) and the client's
        // context meter work for ChatGPT exactly as they do for every other provider.
        const { cached, ...rest } = usage;
        writeChunk(res, { id, object: "chat.completion.chunk", created, model, choices: [], usage: { ...rest, prompt_tokens_details: { cached_tokens: cached } } });
      }
      endStream(res);
    } catch (e) {
      if (ac.signal.aborted) return void res.end();
      chunk({ content: `\n[backend: chatgpt error: ${e instanceof Error ? e.message : String(e)}]` }, "stop");
      endStream(res);
    }
  },

  // The Codex endpoint has no /models. These are the ids a Plus/Pro plan can drive; an id the plan
  // doesn't cover fails at request time with the vendor's own message, which is clearer than
  // anything we could guess here.
  //
  // Returned PREFIXED, and that is load-bearing twice over. /models lists ids unprefixed with only
  // an `owned_by` field, so bare `gpt-5`/`gpt-5.1` would collide with the same ids from the `openai`
  // provider — and worse, route() sends a bare `gpt-*` to `openai`, so picking one from the list
  // would quietly bill the API key instead of the subscription. `chatgpt/…` routes here; the prefix
  // is stripped again in buildCodexBody before the id goes upstream.
  async listModels(): Promise<string[]> {
    const token = await freshToken("chatgpt");
    // Signed out, or on a plan Codex refuses: offer nothing rather than five ids that would each
    // fail at request time. An empty list leaves the picker showing only what can actually run.
    if (!token || planLacksCodex(chatgptPlan(token))) return [];
    return ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1", "gpt-5-codex", "gpt-5"].map((id) => `chatgpt/${id}`);
  },
};

/** demo(): `node --experimental-strip-types codex.ts` — exercises the translation and the SSE
 *  framing, the two places a silent bug would corrupt a whole conversation. */
async function demo(): Promise<void> {
  const assert = (c: unknown, m: string): void => {
    if (!c) throw new Error(`FAIL: ${m}`);
  };

  const { instructions, input } = toResponsesInput([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "ls", arguments: '{"p":"."}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    { role: "user", content: [{ type: "text", text: "and?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
  ]);
  assert(instructions === "be terse", "system messages become `instructions`, not input items");
  assert(!input.some((i) => i.role === "system"), "no system item survives into input");
  assert(input[0]!.type === "message" && (input[0]!.content as Array<{ type: string }>)[0]!.type === "input_text", "user text is input_text");
  assert(input[1]!.type === "function_call" && input[1]!.call_id === "call_1", "tool_calls become function_call with call_id");
  assert(input[2]!.type === "function_call_output" && input[2]!.call_id === "call_1", "tool result pairs on the same call_id");
  const parts = input[3]!.content as Array<{ type: string }>;
  assert(parts[1]!.type === "input_image", "image parts become input_image");
  // An assistant turn with empty content must not emit a stray empty message item — the endpoint
  // rejects a message with no content.
  assert(!input.some((i) => i.type === "message" && i.role === "assistant"), "empty assistant text emits no message item");

  const body = buildCodexBody({ model: "chatgpt/gpt-5.1-codex", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" });
  assert(body.model === "gpt-5.1-codex", "the routing prefix is stripped before the id goes upstream");
  assert(body.store === false, "store is false — the endpoint rejects true");
  assert((body.reasoning as { effort: string }).effort === "high", "reasoning_effort maps onto reasoning.effort");
  assert(!("tools" in body), "no tools key when the request has none");

  // SSE framing: split mid-record and use CRLF, the two ways a naive parser drops events.
  const chunks = ['event: x\r\ndata: {"a":1}\r\n\r\ndata: {"b', '":2}\n\ndata: [DONE]\n\n'];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
  const got: string[] = [];
  for await (const e of sseEvents(stream)) got.push(e.data);
  assert(got.length === 3, `three records across the split, got ${got.length}`);
  assert(got[1] === '{"b":2}', "a record split across reads is reassembled");
  assert(got[2] === "[DONE]", "the terminator survives");

  console.log("codex: all checks passed");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/codex.ts")) void demo();
