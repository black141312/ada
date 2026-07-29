// OpenAI-compatible adapter. Covers every provider that speaks the OpenAI Chat
// Completions format: OpenAI, Mistral, Groq, DeepSeek, xAI, OpenRouter, Together, Ollama,
// and Gemini (via Google's OpenAI-compatible endpoint). Because the client also speaks
// that format, this adapter just swaps in the upstream base URL + key and streams the
// response straight back — no translation needed.

import { readFileSync } from "node:fs";
import type { ProviderName } from "../../shared/types.ts";
import { PROVIDERS, providerKey } from "../config.ts";
import { SSE_HEADERS } from "../sse.ts";
import type { Adapter, ChatRequest } from "./adapter.ts";
import { copilotBearer, invalidateCopilotBearer } from "./copilot-token.ts";

const ADA_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

type Part = { type: string; text?: string; cache_control?: { type: string } };
type Msg = { role?: string; content?: unknown };

/** Claude is the only family that has to be ASKED to cache. DeepSeek, Kimi and OpenAI cache
 *  automatically — which is why their runs report a hit rate and Claude's report none at all.
 *  Routed through an OpenAI-compatible endpoint, nobody was setting `cache_control`, so every turn
 *  of every Claude session re-sent the whole transcript at full price. In an agentic loop that's the
 *  dominant cost: turn 10 re-sends turns 1-9. Cache reads bill at ~0.1x.
 *
 *  One breakpoint, on the last user/assistant turn. Anthropic matches the longest cached prefix, so
 *  a single moving marker keeps the growing history warm. Deliberately NOT on a `tool` message —
 *  those map to tool_result blocks upstream and rewriting their content shape risks breaking the
 *  mapping for a marginal gain.
 *
 *  ponytail: the system prompt is left alone on purpose. Ada appends per-turn extras (repo map,
 *  recalled memories, skill hints) as a trailing system message, and Anthropic folds every system
 *  message into one parameter — so the system block changes each turn and can't be cached as-is.
 *  Making it cacheable means moving the transient parts out of `system` first. */
export function markCacheable(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model ?? "");
  if (!/claude/i.test(model) && !model.startsWith("anthropic/")) return body;
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return body;

  let i = msgs.length - 1;
  while (i >= 0 && (msgs[i] as Msg)?.role !== "user" && (msgs[i] as Msg)?.role !== "assistant") i--;
  if (i < 0) return body;

  const m = msgs[i] as Msg;
  const parts: Part[] | null =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? [...(m.content as Part[])] : null;
  if (!parts?.length) return body; // assistant turns can be tool_calls with null content

  parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: { type: "ephemeral" } };
  const out = msgs.slice();
  out[i] = { ...m, content: parts };
  return { ...body, messages: out };
}

async function authHeaders(provider: ProviderName): Promise<Record<string, string>> {
  // GitHub Copilot: bearer comes from the token exchange (or COPILOT_API_KEY), plus the
  // editor-identification headers its endpoint requires.
  if (provider === "copilot") {
    const bearer = await copilotBearer();
    return {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": `ada/${ADA_VERSION}`,
      "Editor-Plugin-Version": `ada/${ADA_VERSION}`,
    };
  }
  const key = providerKey(provider);
  return key ? { authorization: `Bearer ${key}` } : {};
}

export const openAICompatAdapter: Adapter = {
  async chat({ provider, body, res }: ChatRequest): Promise<void> {
    const def = PROVIDERS[provider];
    // Strip a leading "<provider>/" the router used only to disambiguate (copilot/groq/together) — the
    // endpoint wants the bare id. (Cloudflare's "@cf/…" ids aren't "cloudflare/…", so they pass through.)
    const prefix = `${provider}/`;
    const stripped = typeof body.model === "string" && body.model.startsWith(prefix) ? { ...body, model: body.model.slice(prefix.length) } : body;
    // OpenRouter only returns the cache breakdown (cached_tokens / cache_write_tokens) when asked.
    // Without it a cache hit is invisible and the client prices every token at the fresh rate.
    const withUsage = provider === "openrouter" ? { ...stripped, usage: { include: true } } : stripped;
    const outBody = markCacheable(withUsage);
    // If the client goes away, abort the upstream too — else the full completion is generated,
    // billed, and (for enterprise) metered against a request nobody is reading.
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${def.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(provider)) },
        body: JSON.stringify(outBody),
        signal: ac.signal,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `could not reach ${provider} upstream at ${def.baseURL}: ${e instanceof Error ? e.message : String(e)}` },
        }),
      );
      return;
    }

    if (!upstream.ok || !upstream.body) {
      // A dead exchanged bearer (revoked / clock skew) would otherwise be reused until local expiry.
      if (provider === "copilot" && upstream.status === 401) invalidateCopilotBearer();
      const text = await upstream.text().catch(() => "");
      res.writeHead(upstream.status || 502, { "content-type": "application/json" });
      res.end(text || JSON.stringify({ error: { message: `upstream error ${upstream.status}` } }));
      return;
    }

    if (body.stream) {
      res.writeHead(200, SSE_HEADERS);
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) {
            await reader.cancel(); // client gone → stop pulling tokens from upstream
            break;
          }
          if (value) res.write(Buffer.from(value));
        }
      } catch {
        /* aborted mid-stream (client closed) — nothing more to do */
      }
      res.end();
    } else {
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(text);
    }
  },

  async listModels(provider: ProviderName): Promise<string[]> {
    const def = PROVIDERS[provider];
    try {
      const r = await fetch(`${def.baseURL}/models`, { headers: await authHeaders(provider) });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  },
};
