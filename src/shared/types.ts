// Types shared between the ada client and backend.

export type ProviderName =
  | "openai"
  | "anthropic"
  | "chatgpt" // a ChatGPT Plus/Pro subscription (Codex endpoint), NOT the pay-per-token openai API
  | "google"
  | "mistral"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "together"
  | "xai"
  | "dashscope"
  | "copilot"
  | "cloudflare"
  | "ollama"
  | "omniroute";

export interface ModelInfo {
  id: string;
  provider: ProviderName;
}
