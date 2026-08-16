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
 *  A second breakpoint goes on the LAST system message. That used to be impossible: Ada put the
 *  per-turn extras (recalled memories, skill hints) in a trailing system message, Anthropic folds
 *  every system message into one parameter, and a single per-turn byte in there changed the prefix.
 *  The agent now sends only stable content as `system` — the repo map, built once per session — and
 *  the per-turn hints as a trailing USER message, so the folded system param is finally stable.
 *
 *  Marking system also caches the TOOL SCHEMAS, which is the bigger prize: Anthropic's cache prefix
 *  runs tools → system → messages, so a breakpoint on system covers everything ahead of it. ~57
 *  registered tools were being re-sent at full price on every iteration of every agent loop. We do
 *  NOT put `cache_control` on the tool objects themselves the way the native anthropic.ts path can —
 *  it isn't part of the OpenAI tool schema, and an unexpected field is a 400 from several providers.
 *  Going through the system block gets the same coverage without that risk. */
export function markCacheable(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model ?? "");
  if (!/claude/i.test(model) && !model.startsWith("anthropic/")) return body;
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return body;

  // Second-to-last user/assistant turn, not the last. The final turn may be per-turn guidance that
  // differs every request; anchoring the breakpoint there would mint a fresh cache entry each time
  // and never read one. One turn behind is always content both requests share, so the cache holds.
  // The excluded turn joins the cached prefix on the next request — normal incremental caching.
  const turns: number[] = [];
  for (let j = msgs.length - 1; j >= 0 && turns.length < 2; j--) {
    const role = (msgs[j] as Msg)?.role;
    if (role === "user" || role === "assistant") turns.push(j);
  }
  const i = turns.length >= 2 ? turns[1]! : (turns[0] ?? -1);

  const out = msgs.slice();
  let marked = false;

  /** Rewrite one message's content to block form and put the breakpoint on its last block. */
  const mark = (at: number): void => {
    const m = out[at] as Msg;
    const parts: Part[] | null =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? [...(m.content as Part[])] : null;
    if (!parts?.length) return; // assistant turns can be tool_calls with null content
    if (parts.some((p) => p.cache_control)) return; // already marked — don't spend a second breakpoint
    parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: { type: "ephemeral" } };
    out[at] = { ...m, content: parts };
    marked = true;
  };

  // The LAST system message, so the breakpoint sits after every system block upstream folds together
  // — and therefore after the tool schemas too.
  for (let j = msgs.length - 1; j >= 0; j--) {
    if ((msgs[j] as Msg)?.role === "system") {
      mark(j);
      break;
    }
  }

  if (i >= 0) mark(i);
  return marked ? { ...body, messages: out } : body;
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
