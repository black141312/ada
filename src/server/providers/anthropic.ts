// Native Anthropic adapter. Anthropic's Messages API is NOT OpenAI-shaped, so this adapter
// translates the OpenAI request → Anthropic Messages, streams it, and re-emits Anthropic
// events as OpenAI SSE chunks. The @anthropic-ai/sdk is loaded lazily (top-level `import type`
// is erased at runtime; the dynamic import() only runs the first time a Claude request
// arrives) — so the SDK never loads unless Anthropic is actually used.

import type AnthropicSDK from "@anthropic-ai/sdk";
import { providerKey } from "../config.ts";
import { endStream, SSE_HEADERS, writeChunk } from "../sse.ts";
import type { Adapter, ChatRequest } from "./adapter.ts";

let cached: AnthropicSDK | null = null;
async function getClient(): Promise<AnthropicSDK> {
  if (!cached) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    cached = new Anthropic({ apiKey: providerKey("anthropic") });
  }
  return cached;
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

    try {
      const client = await getClient();
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
      const systemParam = system ? [{ type: "text", text: system, cache_control: cacheControl }] : undefined;

      const params = {
        model,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 8192,
        ...(systemParam ? { system: systemParam } : {}),
        messages: messages as unknown as AnthropicSDK.MessageParam[],
        ...(tools.length ? { tools: tools as AnthropicSDK.Tool[] } : {}),
      } as unknown as Parameters<typeof client.messages.stream>[0];

      const stream = client.messages.stream(
        params,
        ttl1h ? { headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" } } : undefined,
      );

      for await (const event of stream) {
        if (event.type === "content_block_start") {
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
        }
      }

      chunk({}, stop);
      endStream(res);
    } catch (err) {
      chunk({ content: `\n[backend: anthropic error: ${err instanceof Error ? err.message : String(err)}]` }, "stop");
      endStream(res);
    }
  },

  async listModels(): Promise<string[]> {
    const key = providerKey("anthropic");
    if (!key) return [];
    try {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  },
};
