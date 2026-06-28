// Types shared between the ada client and backend.

export type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "together"
  | "xai"
  | "dashscope"
  | "ollama";

export interface ModelInfo {
  id: string;
  provider: ProviderName;
}
