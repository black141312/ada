// Map a model id (and optional explicit provider) to a provider.
// Order matters: explicit wins; then the shape of the id (namespaced / local); then base-name prefixes.

import type { ProviderName } from "../shared/types.ts";
import { PROVIDERS } from "./config.ts";

export function route(model: string, explicit?: string): ProviderName {
  if (explicit && explicit in PROVIDERS) return explicit as ProviderName;

  const m = model.toLowerCase();

  // "vendor/model" → OpenRouter's namespacing convention. Checked before base-name prefixes
  // so e.g. "mistralai/…" routes to OpenRouter, not the Mistral API.
  // Prefixed ids that must beat the OpenRouter "/" rule below:
  if (m.startsWith("@cf/")) return "cloudflare"; // Cloudflare Workers AI model ids
  if (m.startsWith("copilot/")) return "copilot";
  // `groq/…` / `together/…` disambiguate shared model names (llama-3.3, gemma2…) that no prefix can.
  if (m.startsWith("groq/")) return "groq";
  if (m.startsWith("together/")) return "together";
  if (m.includes("/")) return "openrouter";
  // "model:tag" → a local Ollama model (e.g. gemma4:latest).
  if (m.includes(":")) return "ollama";

  if (/^(gpt|o1|o3|o4|chatgpt|text-|davinci)/.test(m)) return "openai";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini") || m.startsWith("gemma")) return "google";
  if (/^(mistral|codestral|magistral|ministral|devstral|pixtral|open-mi)/.test(m)) return "mistral";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "dashscope";

  return "openrouter"; // default: one key, every model
}
