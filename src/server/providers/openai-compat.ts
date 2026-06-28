// OpenAI-compatible adapter. Covers every provider that speaks the OpenAI Chat
// Completions format: OpenAI, Mistral, Groq, DeepSeek, xAI, OpenRouter, Together, Ollama,
// and Gemini (via Google's OpenAI-compatible endpoint). Because the client also speaks
// that format, this adapter just swaps in the upstream base URL + key and streams the
// response straight back — no translation needed.

import type { ProviderName } from "../../shared/types.ts";
import { PROVIDERS, providerKey } from "../config.ts";
import { SSE_HEADERS } from "../sse.ts";
import type { Adapter, ChatRequest } from "./adapter.ts";

function authHeaders(provider: ProviderName): Record<string, string> {
  const key = providerKey(provider);
  return key ? { authorization: `Bearer ${key}` } : {};
}

export const openAICompatAdapter: Adapter = {
  async chat({ provider, body, res }: ChatRequest): Promise<void> {
    const def = PROVIDERS[provider];
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${def.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(provider) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `could not reach ${provider} upstream at ${def.baseURL}: ${e instanceof Error ? e.message : String(e)}` },
        }),
      );
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      res.writeHead(upstream.status || 502, { "content-type": "application/json" });
      res.end(text || JSON.stringify({ error: { message: `upstream error ${upstream.status}` } }));
      return;
    }

    if (body.stream) {
      res.writeHead(200, SSE_HEADERS);
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
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
      const r = await fetch(`${def.baseURL}/models`, { headers: authHeaders(provider) });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  },
};
