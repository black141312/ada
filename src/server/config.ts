// Backend configuration: provider upstreams, keys, client-key auth, port.
// Everything is env-driven. The backend is the only place provider keys live.

import { getCredential } from "./credentials.ts";
import type { ProviderName } from "../shared/types.ts";

export interface ProviderDef {
  baseURL: string; // OpenAI-compatible base (…/v1) — every provider is proxied as-is
  keyEnv: string; // env var holding this provider's key ("" = keyless, e.g. local Ollama)
}

export const PROVIDERS: Record<ProviderName, ProviderDef> = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  anthropic: { baseURL: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY" },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  mistral: { baseURL: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  deepseek: { baseURL: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
  together: { baseURL: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  xai: { baseURL: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  dashscope: {
    baseURL: process.env.DASHSCOPE_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
  },
  // GitHub Copilot — OpenAI-compatible chat endpoint. Set COPILOT_API_KEY (a Copilot bearer you
  // already have) OR COPILOT_GITHUB_TOKEN (a GitHub token with Copilot access — the adapter runs
  // the /copilot_internal/v2/token exchange and caches/refreshes the bearer; see copilot-token.ts).
  copilot: { baseURL: process.env.COPILOT_BASE_URL ?? "https://api.githubcopilot.com", keyEnv: "COPILOT_API_KEY" },
  // Cloudflare Workers AI / AI Gateway — OpenAI-compatible. Workers AI: set CLOUDFLARE_ACCOUNT_ID +
  // CLOUDFLARE_API_TOKEN (default URL). AI Gateway: point CLOUDFLARE_BASE_URL at the gateway URL.
  // Model ids are `@cf/<vendor>/<model>` (e.g. @cf/moonshotai/kimi-k2.7-code) — sent through as-is.
  cloudflare: {
    baseURL: process.env.CLOUDFLARE_BASE_URL ?? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID ?? ""}/ai/v1`,
    keyEnv: "CLOUDFLARE_API_TOKEN",
  },
  ollama: { baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1", keyEnv: "" },
};

export const PORT = Number(process.env.ADA_PORT) || 8787;

/** The ada client keys allowed to use this backend. null = auth disabled (dev mode). */
export function clientKeys(): string[] | null {
  const v = process.env.ADA_CLIENT_KEYS;
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The upstream provider key: env var first, then a stored credential (API key or OAuth token). */
export function providerKey(p: ProviderName): string | undefined {
  const env = PROVIDERS[p].keyEnv;
  if (env && process.env[env]) return process.env[env];
  const cred = getCredential(p);
  if (cred) return cred.type === "oauth" ? cred.access : cred.key;
  return undefined; // keyless provider (Ollama) or unconfigured
}

/** A provider is usable if it's keyless, its key env var is set, or a credential is stored. */
export function isConfigured(p: ProviderName): boolean {
  // Copilot has a second way in: a GitHub token the adapter exchanges for a bearer (copilot-token.ts).
  if (p === "copilot" && process.env.COPILOT_GITHUB_TOKEN) return true;
  return PROVIDERS[p].keyEnv === "" || !!process.env[PROVIDERS[p].keyEnv] || !!getCredential(p);
}

export function configuredProviders(): ProviderName[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).filter(isConfigured);
}

/** Every provider + whether/how it's configured — the truth behind "what is ada connected to?".
 *  source: env = key env var set · key = stored credential (/connect) · keyless = no key needed (Ollama). */
export function providerStatus(): Array<{ name: ProviderName; configured: boolean; source: "env" | "key" | "keyless" | "none" }> {
  return (Object.keys(PROVIDERS) as ProviderName[]).map((p) => {
    const env = PROVIDERS[p].keyEnv;
    const source = env === "" ? "keyless" : process.env[env] ? "env" : getCredential(p) ? "key" : p === "copilot" && process.env.COPILOT_GITHUB_TOKEN ? "env" : "none";
    return { name: p, configured: source !== "none", source };
  });
}
