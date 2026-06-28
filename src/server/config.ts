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
  return PROVIDERS[p].keyEnv === "" || !!process.env[PROVIDERS[p].keyEnv] || !!getCredential(p);
}

export function configuredProviders(): ProviderName[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).filter(isConfigured);
}
