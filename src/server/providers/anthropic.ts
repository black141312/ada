// Native Anthropic adapter. Anthropic's Messages API is NOT OpenAI-shaped, so this adapter
// translates the OpenAI request → Anthropic Messages, streams it, and re-emits Anthropic
// events as OpenAI SSE chunks. The @anthropic-ai/sdk is loaded lazily (top-level `import type`
// is erased at runtime; the dynamic import() only runs the first time a Claude request
// arrives) — so the SDK never loads unless Anthropic is actually used.

import type AnthropicSDK from "@anthropic-ai/sdk";
import { providerKey } from "../config.ts";
import { endStream, SSE_HEADERS, writeChunk } from "../sse.ts";
import type { Adapter, ChatRequest } from "./adapter.ts";
import { freshToken } from "./subscription-oauth.ts";

/** A Claude Pro/Max subscription token, as opposed to a `sk-ant-api…` key. The two authenticate
 *  differently (bearer vs x-api-key) and the subscription route needs extra beta opt-ins. */
export const isSubscriptionToken = (k: string): boolean => k.startsWith("sk-ant-oat");

/** Betas the subscription route requires. Without `oauth-2025-04-20` the token is refused; without
 *  `claude-code-*` the request is treated as an API-key call and the plan doesn't cover it. */
const SUBSCRIPTION_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

/** Sent as the first system block on the subscription route — the plan only covers Claude Code
 *  traffic, and Anthropic rejects the request without it. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** OpenAI's `reasoning_effort` → Anthropic's thinking budget. Anthropic's floor is 1024 tokens.
 *  Without this the effort the user picked with `/reasoning` was simply dropped for every Claude
 *  model: the field has no meaning in the Messages API, so Claude never thought and the client
 *  had nothing to print. */
const THINK_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16384 };

// Keyed by token: a refreshed subscription token must not keep using a client built on the old one.
let cached: { token: string; client: AnthropicSDK } | null = null;
async function getClient(): Promise<{ client: AnthropicSDK; subscription: boolean }> {
  // freshToken renews an expiring subscription token; "" means there's no subscription, so fall
  // back to the API key.
  const token = (await freshToken("anthropic")) || providerKey("anthropic") || "";
  const subscription = isSubscriptionToken(token);
  if (cached?.token !== token) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    cached = {
      token,
      // The SDK sends `authToken` as `Authorization: Bearer`; apiKey null keeps it from also
      // sending x-api-key, which the subscription endpoint rejects.
      client: subscription ? new Anthropic({ apiKey: null, authToken: token }) : new Anthropic({ apiKey: token }),
    };
  }
  return { client: cached.client, subscription };
}

type OAIMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

type Block = Record<string, unknown>;

/**
 * Thinking blocks, keyed by the first tool_use id of the turn that produced them.
 *
 * Anthropic's contract for extended thinking is that the assistant turn which called a tool is
 * replayed with the thinking blocks it produced still on the front, signature and all. The OpenAI
 * wire format the client speaks has nowhere to carry one, so the adapter remembers them here and
 * re-attaches them on the way back out.
 *
 * Measured, not assumed: a Claude turn whose tool_use arrives with no thinking block in front of it
 * is currently ACCEPTED rather than rejected — so this is about the model keeping its own reasoning
 * across a tool call, not about dodging a 400. A signature that gets replayed *wrong* is a 400,
 * which is why the blocks are stored verbatim rather than reconstructed.
 *
 * ponytail: an in-process Map, capped. A gateway restart mid-conversation just loses it; the turn
 * goes out without the block and the retry in `chat` covers a provider that turns strict. Move it
 * beside the transcript if the gateway ever goes multi-process.
 */
const thinkingByCall = new Map<string, Block[]>();
const THINKING_CACHE_MAX = 64;

export function rememberThinking(callId: string, blocks: Block[]): void {
  if (!callId || !blocks.length) return;
  thinkingByCall.set(callId, blocks);
  for (const k of thinkingByCall.keys()) {
    if (thinkingByCall.size <= THINKING_CACHE_MAX) break;
    thinkingByCall.delete(k);
  }
}

/** OpenAI messages[] → Anthropic { system, messages[] }. */
/**
 * Make every tool_use / tool_result pair adjacent, the way Anthropic requires.
 *
 * The OpenAI API tolerates a transcript where a tool call's result is missing, arrives late, or has
 * something in between. Anthropic refuses the whole request:
 *
 *   messages.414: tool_use ids were found without tool_result blocks immediately after: toolu_…
 *   Each tool_use block must have a corresponding tool_result block in the next message.
 *
 * That is a 400 on EVERY subsequent turn, so one malformed pair anywhere in the history bricks the
 * conversation — and the transcript can drift into that shape for ordinary reasons: compaction
 * dropping a result while keeping the call, a tool interrupted mid-flight, a message landing
 * between the two.
 *
 * So repair rather than forward it: synthesize a result for any call that lacks one, and drop
 * results that answer no call (the mirror case, which Anthropic also rejects). The synthesized text
 * is visible to the model on purpose — "no result" is the truth about what happened, and inventing
 * a plausible-looking success would be worse than saying so.
 */
export function repairToolPairs(messages: Block[]): Block[] {
  const out: Block[] = [];

  const idsOf = (m: Block | undefined, type: string, key: string): string[] =>
    Array.isArray(m?.content)
      ? (m.content as Block[]).filter((b) => b?.type === type).map((b) => String(b[key] ?? ""))
      : [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "user" && Array.isArray(msg.content)) {
      // Drop tool_results that answer no immediately-preceding call. Anything else in the message
      // (text, images) is untouched — only the orphaned results go.
      const expected = new Set(idsOf(out[out.length - 1], "tool_use", "id"));
      const kept = (msg.content as Block[]).filter((b) => b?.type !== "tool_result" || expected.has(String(b.tool_use_id ?? "")));
      if (!kept.length) continue; // nothing left to say — dropping the turn beats sending an empty one
      out.push({ ...msg, content: kept });
      continue;
    }

    out.push(msg);

    const calls = idsOf(msg, "tool_use", "id");
    if (msg.role !== "assistant" || !calls.length) continue;

    // Whatever answers this turn must be the very next message, and must cover every id.
    const next = messages[i + 1];
    const answered = new Set(next?.role === "user" ? idsOf(next, "tool_result", "tool_use_id") : []);
    const missing = calls.filter((id) => !answered.has(id));
    if (!missing.length) continue;

    const filler: Block[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "(no result recorded — the tool did not report back)",
    }));

    if (next?.role === "user" && Array.isArray(next.content)) {
      // Merge into the reply that's already there, so ordering and any text it carries survive.
      messages[i + 1] = { ...next, content: [...filler, ...(next.content as Block[])] };
    } else {
      out.push({ role: "user", content: filler });
    }
  }

  return out;
}

export function convert(messages: OAIMessage[]): { system?: string; messages: Block[] } {
  const system: string[] = [];
  const out: Block[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "system") {
      if (typeof msg.content === "string") system.push(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      // Merge a run of consecutive tool messages into one Anthropic user turn.
      const results: Block[] = [];
      let j = i;
      while (j < messages.length && messages[j]!.role === "tool") {
        const t = messages[j]!;
        results.push({ type: "tool_result", tool_use_id: t.tool_call_id, content: String(t.content ?? "") });
        j++;
      }
      out.push({ role: "user", content: results });
      i = j - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: Block[] = [];
      // Thinking goes FIRST, ahead of any text — that is the order Anthropic checks for.
      const firstCall = msg.tool_calls?.[0]?.id;
      if (firstCall) blocks.push(...(thinkingByCall.get(firstCall) ?? []));
      if (msg.content) blocks.push({ type: "text", text: String(msg.content) });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no content)" }] });
      continue;
    }

    if (Array.isArray(msg.content)) {
      // multimodal user turn: translate OpenAI parts → Anthropic blocks (text + base64 images)
      const blocks: Block[] = (msg.content as Array<Record<string, unknown>>).map((part) => {
        if (part.type === "image_url") {
          const url = String((part.image_url as { url?: string })?.url ?? "");
          const m = /^data:(.+?);base64,(.*)$/.exec(url);
          if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
          return { type: "image", source: { type: "url", url } };
        }
        return { type: "text", text: String(part.text ?? "") };
      });
      out.push({ role: "user", content: blocks });
    } else {
      out.push({ role: "user", content: typeof msg.content === "string" ? msg.content : String(msg.content ?? "") });
    }
  }

  return { system: system.length ? system.join("\n\n") : undefined, messages: repairToolPairs(out) };
}

/** Mark the end of the transcript cacheable, so each turn cache-*reads* every prior turn instead of
 *  re-paying full input price for it. Anthropic matches the longest cached prefix, so one moving
 *  breakpoint on the final block is enough — the growing history stays a hit. Caching system+tools
 *  alone (the previous behaviour) left the messages array, which is most of an agentic turn's input,
 *  uncached. Cheap no-ops on a one-shot call; the win scales with tool-loop depth. */
export function markLastBlockCacheable(messages: Block[], cacheControl: Record<string, string>): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  // Normalize string content to block form — cache_control lives on a block, not on the message.
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  const blocks = last.content as Block[] | undefined;
  if (!Array.isArray(blocks) || !blocks.length) return;
  blocks[blocks.length - 1]!.cache_control = cacheControl;
}

function mapStop(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export const anthropicAdapter: Adapter = {
  async chat({ body, res }: ChatRequest): Promise<void> {
    const id = `chatcmpl-${Math.random().toString(16).slice(2, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = String(body.model);
    const chunk = (delta: Block, finish: string | null = null) =>
      writeChunk(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

    res.writeHead(200, SSE_HEADERS);
    chunk({ role: "assistant" });

    let stop = "stop";
    let toolIndex = -1;
    let inTokens = 0; // Anthropic reports input on message_start, cumulative output on message_delta
    let outTokens = 0;
    // Cached input is billed separately (reads ~0.1x, writes ~1.25x) and is NOT included in
    // input_tokens — counting only input_tokens both hides the cache and misprices the turn.
    let cacheRead = 0;
    let cacheWrite = 0;

    try {
      const { client, subscription } = await getClient();
      const { system, messages } = convert((body.messages as OAIMessage[]) ?? []);
      const tools = (
        (body.tools as Array<{ function: { name: string; description?: string; parameters?: unknown } }>) ?? []
      ).map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        input_schema: (t.function.parameters as object) ?? { type: "object", properties: {} },
      }));

      // Prompt caching: mark the stable prefix (system + tools) cacheable. ADA_CACHE_TTL=1h opts
      // into the 1-hour cache (otherwise Anthropic's default 5-minute ephemeral cache applies).
      const ttl1h = process.env.ADA_CACHE_TTL === "1h";
      const cacheControl: Record<string, string> = { type: "ephemeral" };
      if (ttl1h) cacheControl.ttl = "1h";
      if (tools.length) (tools[tools.length - 1] as Record<string, unknown>).cache_control = cacheControl;
      // On the subscription route the identity block goes FIRST and ada's own system prompt follows
      // it as a second block — appending it or merging the two doesn't satisfy the check.
      const systemBlocks = [
        ...(subscription ? [{ type: "text", text: CLAUDE_CODE_IDENTITY }] : []),
        ...(system ? [{ type: "text", text: system, cache_control: cacheControl }] : []),
      ];
      const systemParam = systemBlocks.length ? systemBlocks : undefined;
      markLastBlockCacheable(messages, cacheControl);

      const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 8192;

      // One merged anthropic-beta header: a second `headers` object would replace the first, so the
      // subscription betas and the cache-TTL beta have to be joined rather than set separately.
      const betas = [...(subscription ? SUBSCRIPTION_BETAS : []), ...(ttl1h ? ["extended-cache-ttl-2025-04-11"] : [])];
      const reqOpts = betas.length
        ? { headers: { "anthropic-beta": betas.join(","), ...(subscription ? { "user-agent": "claude-cli/1.0.0 (external, cli)" } : {}) } }
        : undefined;

      // Extended thinking, if the caller asked for it.
      let budget: number | undefined = THINK_BUDGET[String(body.reasoning_effort ?? "")];
      let streamed = false; // any of the model's own output already on the wire
      const emit = (delta: Block): void => {
        streamed = true;
        chunk(delta);
      };

      const attempt = async (): Promise<void> => {
        stop = "stop"; // a retry starts from a clean slate — the failed attempt's tallies are void
        toolIndex = -1;
        inTokens = outTokens = cacheRead = cacheWrite = 0;

        const params = {
          model,
          // The budget is spent out of max_tokens, so a request that only budgets thinking has no
          // room left to answer in.
          max_tokens: budget ? Math.max(maxTokens, budget + 8192) : maxTokens,
          ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
          ...(systemParam ? { system: systemParam } : {}),
          messages: messages as unknown as AnthropicSDK.MessageParam[],
          ...(tools.length ? { tools: tools as AnthropicSDK.Tool[] } : {}),
        } as unknown as Parameters<typeof client.messages.stream>[0];

        const stream = client.messages.stream(params, reqOpts);

        // Rebuilt verbatim from the deltas so the exact blocks (signature and all) can be replayed
        // on the next request — see `thinkingByCall`.
        const thinkingBlocks: Block[] = [];
        let openThinking: { type: string; thinking: string; signature: string } | null = null;
        let firstToolUseId = "";

        for await (const event of stream) {
          if (event.type === "message_start") {
            const u = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
            inTokens = u?.input_tokens ?? 0;
            cacheRead = u?.cache_read_input_tokens ?? 0;
            cacheWrite = u?.cache_creation_input_tokens ?? 0;
          } else if (event.type === "content_block_start") {
            const cb = event.content_block as { type: string; id?: string; name?: string; data?: string };
            if (cb.type === "tool_use") {
              toolIndex++;
              firstToolUseId ||= cb.id ?? "";
              emit({ tool_calls: [{ index: toolIndex, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] });
            } else if (cb.type === "thinking") {
              openThinking = { type: "thinking", thinking: "", signature: "" };
            } else if (cb.type === "redacted_thinking") {
              // Encrypted by Anthropic — nothing to show a human, but it still has to be replayed.
              thinkingBlocks.push({ type: "redacted_thinking", data: cb.data });
            }
          } else if (event.type === "content_block_delta") {
            const d = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
            if (d.type === "text_delta") emit({ content: d.text });
            else if (d.type === "input_json_delta") emit({ tool_calls: [{ index: toolIndex, function: { arguments: d.partial_json } }] });
            else if (d.type === "thinking_delta") {
              if (openThinking) openThinking.thinking += d.thinking ?? "";
              // `reasoning_content` is the field the client already reads — never `content`, which
              // would fold the model's scratch work into the answer and into every later request.
              emit({ reasoning_content: d.thinking });
            } else if (d.type === "signature_delta") {
              if (openThinking) openThinking.signature += d.signature ?? "";
            }
          } else if (event.type === "content_block_stop") {
            if (openThinking) thinkingBlocks.push({ ...openThinking });
            openThinking = null;
          } else if (event.type === "message_delta") {
            const reason = (event.delta as { stop_reason?: string | null }).stop_reason;
            if (reason) stop = mapStop(reason);
            const ot = (event as { usage?: { output_tokens?: number } }).usage?.output_tokens;
            if (typeof ot === "number") outTokens = ot; // cumulative — take the latest
          }
        }

        rememberThinking(firstToolUseId, thinkingBlocks);
      };

      try {
        await attempt();
      } catch (e) {
        // Thinking is the one part of this request that can be refused on its own: a model that
        // doesn't support it, a budget it won't take, a transcript Anthropic wants a thinking
        // block in. None of that is worth costing the user their turn — drop thinking and send it
        // again. Only while nothing has shipped: retrying after output would restart the answer on
        // top of itself, and no provider can resume a completion cut mid-sentence.
        if (!budget || streamed) throw e;
        budget = undefined;
        await attempt();
      }

      chunk({}, stop);
      // Emit an OpenAI-shaped usage chunk so the backend's metering (and the client's own token
      // counters) work for Claude too — Anthropic doesn't send one in this wire format.
      // prompt_tokens is the TRUE context size (fresh + cached), so the client's context meter and
      // compaction threshold are right; the split rides along in prompt_tokens_details so cost can
      // discount cache reads instead of billing them at full input price.
      const promptTokens = inTokens + cacheRead + cacheWrite;
      writeChunk(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: outTokens,
          total_tokens: promptTokens + outTokens,
          prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite },
        },
      });
      endStream(res);
    } catch (err) {
      chunk({ content: `\n[backend: anthropic error: ${err instanceof Error ? err.message : String(err)}]` }, "stop");
      endStream(res);
    }
  },

  async listModels(): Promise<string[]> {
    const key = (await freshToken("anthropic")) || providerKey("anthropic");
    if (!key) return [];
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: {
          "anthropic-version": "2023-06-01",
          // Same split as chat: bearer for a subscription token, x-api-key for an API key.
          ...(isSubscriptionToken(key)
            ? { authorization: `Bearer ${key}`, "anthropic-beta": SUBSCRIPTION_BETAS.join(",") }
            : { "x-api-key": key }),
        },
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  },
};

/** demo(): `node --experimental-strip-types anthropic.ts` — the tool-pairing rules Anthropic
 *  enforces, each of which returns a 400 that bricks the whole conversation when violated. */
async function demo(): Promise<void> {
  const assert = (c: unknown, m: string): void => {
    if (!c) throw new Error(`FAIL: ${m}`);
  };
  const use = (id: string): Block => ({ type: "tool_use", id, name: "ls", input: {} });
  const result = (id: string): Block => ({ type: "tool_result", tool_use_id: id, content: "ok" });
  const resultsOf = (m: Block | undefined): string[] =>
    Array.isArray(m?.content) ? (m.content as Block[]).filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id)) : [];

  // Well-formed input must survive untouched.
  const ok = repairToolPairs([
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [result("a")] },
  ]);
  assert(ok.length === 2 && resultsOf(ok[1]).join() === "a", "a correct pair is left alone");

  // The reported failure: a call with no result at all.
  const orphanCall = repairToolPairs([{ role: "assistant", content: [use("a")] }]);
  assert(orphanCall.length === 2, "a result turn is synthesized for an unanswered call");
  assert(resultsOf(orphanCall[1]).join() === "a", "and it answers the right id");

  // A call answered by something that isn't its result — the message in between is what breaks it.
  const interrupted = repairToolPairs([
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [{ type: "text", text: "actually, stop" }] },
  ]);
  assert(resultsOf(interrupted[1]).join() === "a", "the missing result is merged into the next turn");
  assert(
    Array.isArray(interrupted[1]!.content) && (interrupted[1]!.content as Block[]).some((b) => b.type === "text"),
    "without discarding what the user said",
  );

  // Partially answered: only the missing ids get filled.
  const partial = repairToolPairs([
    { role: "assistant", content: [use("a"), use("b")] },
    { role: "user", content: [result("b")] },
  ]);
  assert(resultsOf(partial[1]).sort().join() === "a,b", "every unanswered id is covered");

  // The mirror case Anthropic also rejects: a result answering no call.
  const orphanResult = repairToolPairs([
    { role: "user", content: "hi" },
    { role: "user", content: [result("ghost")] },
  ]);
  assert(orphanResult.length === 1, "a result with no matching call is dropped, not forwarded");

  // An orphan result alongside real text keeps the text.
  const mixed = repairToolPairs([{ role: "user", content: [result("ghost"), { type: "text", text: "hello" }] }]);
  assert(resultsOf(mixed[0]).length === 0 && (mixed[0]!.content as Block[]).length === 1, "only the orphan goes");

  // --- extended thinking -------------------------------------------------------------------
  // A tool-calling assistant turn, as the OpenAI-shaped transcript stores it: no thinking block,
  // because the wire format has nowhere to put one.
  const toolTurn = [
    { role: "user", content: "list the files" },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "a.txt" },
  ] as unknown as Parameters<typeof convert>[0];

  const blocksOf = (m: Block | undefined): Block[] => (Array.isArray(m?.content) ? (m.content as Block[]) : []);

  // Nothing remembered yet → the turn goes out as-is. Not an error, just a turn the model has to
  // re-reason; `chat`'s retry is what covers a provider that refuses the shape outright.
  const bare = convert(toolTurn).messages;
  assert(blocksOf(bare[1])[0]?.type === "tool_use", "with nothing cached the turn is unchanged");

  // Once the stream has been seen, the same transcript replays the thinking block ahead of the
  // tool_use — the shape Anthropic demands.
  rememberThinking("toolu_1", [{ type: "thinking", thinking: "the user wants a listing", signature: "sig-abc" }]);
  const restored = convert(toolTurn).messages;
  const first = blocksOf(restored[1])[0];
  assert(first?.type === "thinking", "the remembered thinking block leads the assistant turn");
  assert(first?.signature === "sig-abc", "and carries its signature verbatim — Anthropic verifies it");
  assert(blocksOf(restored[1])[1]?.type === "tool_use", "with the tool call still behind it");

  // Text and tool_use in the same turn: thinking still goes first, ahead of the text.
  rememberThinking("toolu_2", [{ type: "thinking", thinking: "…", signature: "s" }]);
  const withText = convert([
    { role: "assistant", content: "on it", tool_calls: [{ id: "toolu_2", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "toolu_2", content: "ok" },
  ] as unknown as Parameters<typeof convert>[0]).messages;
  assert(blocksOf(withText[0]).map((b) => b.type).join() === "thinking,text,tool_use", "thinking, then text, then the call");

  assert(THINK_BUDGET.low! >= 1024 && THINK_BUDGET.high! > THINK_BUDGET.medium!, "budgets clear Anthropic's 1024 floor and increase with effort");

  console.log("anthropic: all checks passed");
}

if (process.argv[1]?.endsWith("anthropic.ts")) void demo();
