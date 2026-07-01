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
    const outBody = typeof body.model === "string" && body.model.startsWith(prefix) ? { ...body, model: body.model.slice(prefix.length) } : body;
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${def.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(provider)) },
        body: JSON.stringify(outBody),
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
      const r = await fetch(`${def.baseURL}/models`, { headers: await authHeaders(provider) });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      return (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  },
};
