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

/** OpenAI messages[] → Anthropic { system, messages[] }. */
function convert(messages: OAIMessage[]): { system?: string; messages: Block[] } {
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

  return { system: system.length ? system.join("\n\n") : undefined, messages: out };
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

      const params = {
        model,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 8192,
        ...(systemParam ? { system: systemParam } : {}),
        messages: messages as unknown as AnthropicSDK.MessageParam[],
        ...(tools.length ? { tools: tools as AnthropicSDK.Tool[] } : {}),
      } as unknown as Parameters<typeof client.messages.stream>[0];

      // One merged anthropic-beta header: a second `headers` object would replace the first, so the
      // subscription betas and the cache-TTL beta have to be joined rather than set separately.
      const betas = [...(subscription ? SUBSCRIPTION_BETAS : []), ...(ttl1h ? ["extended-cache-ttl-2025-04-11"] : [])];
      const stream = client.messages.stream(
        params,
        betas.length
          ? { headers: { "anthropic-beta": betas.join(","), ...(subscription ? { "user-agent": "claude-cli/1.0.0 (external, cli)" } : {}) } }
          : undefined,
      );

      for await (const event of stream) {
        if (event.type === "message_start") {
          const u = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
          inTokens = u?.input_tokens ?? 0;
          cacheRead = u?.cache_read_input_tokens ?? 0;
          cacheWrite = u?.cache_creation_input_tokens ?? 0;
        } else if (event.type === "content_block_start") {
          const cb = event.content_block as { type: string; id?: string; name?: string };
          if (cb.type === "tool_use") {
            toolIndex++;
            chunk({ tool_calls: [{ index: toolIndex, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] });
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta as { type: string; text?: string; partial_json?: string };
          if (d.type === "text_delta") chunk({ content: d.text });
          else if (d.type === "input_json_delta") chunk({ tool_calls: [{ index: toolIndex, function: { arguments: d.partial_json } }] });
        } else if (event.type === "message_delta") {
          const reason = (event.delta as { stop_reason?: string | null }).stop_reason;
          if (reason) stop = mapStop(reason);
          const ot = (event as { usage?: { output_tokens?: number } }).usage?.output_tokens;
          if (typeof ot === "number") outTokens = ot; // cumulative — take the latest
        }
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
