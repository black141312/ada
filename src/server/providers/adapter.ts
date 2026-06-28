// The provider adapter pattern.
//
// One adapter per WIRE FORMAT — not per model, not per provider. Most providers speak
// the OpenAI Chat Completions format and share `openAICompatAdapter`; only providers whose
// format genuinely diverges (e.g. Anthropic's Messages API) get their own adapter.
//
// Every adapter takes an OpenAI-format request and streams an OpenAI-format SSE response,
// so the client only ever deals with one wire format.

import type { ServerResponse } from "node:http";
import type { ProviderName } from "../../shared/types.ts";

export interface ChatRequest {
  provider: ProviderName;
  model: string;
  body: Record<string, unknown>; // an OpenAI Chat Completions request body
  res: ServerResponse;
}

export interface Adapter {
  /** Stream an OpenAI-format chat completion (SSE) for `req.provider`. */
  chat(req: ChatRequest): Promise<void>;
  /** List the model ids this provider exposes. */
  listModels(provider: ProviderName): Promise<string[]>;
}
