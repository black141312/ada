// Provider → adapter map. This table is the whole routing story at a glance:
// who shares the OpenAI-compatible adapter, and who has a dedicated one.
//
// Adding support is obvious from here:
//   - new model on an existing provider      → nothing to change
//   - new OpenAI-compatible provider          → add it in config.ts + a line below
//   - new provider with a divergent format    → write an adapter, map it below

import type { ProviderName } from "../../shared/types.ts";
import type { Adapter } from "./adapter.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { openAICompatAdapter } from "./openai-compat.ts";

const ADAPTERS: Record<ProviderName, Adapter> = {
  anthropic: anthropicAdapter, // native: Anthropic Messages API
  openai: openAICompatAdapter,
  google: openAICompatAdapter, // via Google's OpenAI-compatible endpoint
  mistral: openAICompatAdapter,
  openrouter: openAICompatAdapter,
  groq: openAICompatAdapter,
  deepseek: openAICompatAdapter,
  together: openAICompatAdapter,
  xai: openAICompatAdapter,
  dashscope: openAICompatAdapter, // Alibaba Qwen via DashScope's OpenAI-compatible endpoint
  ollama: openAICompatAdapter,
};

export function adapterFor(provider: ProviderName): Adapter {
  return ADAPTERS[provider];
}
