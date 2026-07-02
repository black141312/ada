// Provider table + router for the Cloudflare Worker backend. A self-contained copy of the Node
// server's PROVIDERS/route() (src/server/{config,router}.ts) with keys read from Worker `env`
// bindings instead of process.env — the Node modules can't be imported here (they touch node:fs).

export type ProviderName =
  | "openai" | "anthropic" | "google" | "mistral" | "openrouter" | "groq"
  | "deepseek" | "together" | "xai" | "dashscope" | "copilot" | "cloudflare" | "ollama";

export interface ProviderDef {
  baseURL: string;
  keyEnv: string; // "" = keyless
}

const NAMES: ReadonlySet<string> = new Set([
  "openai", "anthropic", "google", "mistral", "openrouter", "groq",
  "deepseek", "together", "xai", "dashscope", "copilot", "cloudflare", "ollama",
]);

/** Build the provider table from env (some base URLs are env-driven, e.g. a Cloudflare AI Gateway). */
export function providers(env: Record<string, unknown>): Record<ProviderName, ProviderDef> {
  const s = (k: string): string | undefined => (typeof env[k] === "string" ? (env[k] as string) : undefined);
  return {
    openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
    anthropic: { baseURL: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
    google: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
    mistral: { baseURL: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
    openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
    groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
    deepseek: { baseURL: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
    together: { baseURL: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
    xai: { baseURL: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
    dashscope: { baseURL: s("DASHSCOPE_BASE_URL") ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyEnv: "DASHSCOPE_API_KEY" },
    copilot: { baseURL: s("COPILOT_BASE_URL") ?? "https://api.githubcopilot.com", keyEnv: "COPILOT_API_KEY" },
    // Cloudflare Workers AI (OpenAI-compatible) — the first-class provider on this backend. Point
    // CLOUDFLARE_BASE_URL at an AI Gateway to get caching/analytics/rate-limiting across providers.
    cloudflare: { baseURL: s("CLOUDFLARE_BASE_URL") ?? `https://api.cloudflare.com/client/v4/accounts/${s("CLOUDFLARE_ACCOUNT_ID") ?? ""}/ai/v1`, keyEnv: "CLOUDFLARE_API_TOKEN" },
    ollama: { baseURL: s("OLLAMA_BASE_URL") ?? "http://localhost:11434/v1", keyEnv: "" },
  };
}

/** Model id (+ optional explicit provider) → provider. Identical rules to the Node router. */
export function route(model: string, explicit?: string): ProviderName {
  if (explicit && NAMES.has(explicit)) return explicit as ProviderName;
  const m = model.toLowerCase();
  if (m.startsWith("@cf/")) return "cloudflare";
  if (m.startsWith("copilot/")) return "copilot";
  if (m.startsWith("groq/")) return "groq";
  if (m.startsWith("together/")) return "together";
  if (m.includes("/")) return "openrouter";
  if (m.includes(":")) return "ollama";
  if (/^(gpt|o1|o3|o4|chatgpt|text-|davinci)/.test(m)) return "openai";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini") || m.startsWith("gemma")) return "google";
  if (/^(mistral|codestral|magistral|ministral|devstral|pixtral|open-mi)/.test(m)) return "mistral";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen") || m.startsWith("qwq")) return "dashscope";
  return "openrouter";
}

export function providerKey(env: Record<string, unknown>, def: ProviderDef): string | undefined {
  if (!def.keyEnv) return undefined;
  const v = env[def.keyEnv];
  return typeof v === "string" && v ? v : undefined;
}
