// Secrets that must never reach a model-controlled subprocess (the `bash` tool) or a third-party MCP
// server — from either, the model can read them and exfiltrate them upstream in a tool result.
// Denylist (not allowlist), so ordinary shell vars (PATH, HOME, …) AND the user's own tool creds
// (GITHUB_TOKEN, AWS_*, which the model may legitimately use and the user approves per-command) pass
// through — only ada's crown jewels are stripped: provider keys it routes with, the seat/client/admin
// keys, and the auth-signing secret.

const SECRET_ENV = new Set([
  "ADA_ADMIN_KEY", "ADA_CLIENT_KEY", "ADA_CLIENT_KEYS", "BETTER_AUTH_SECRET",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "TOGETHER_API_KEY",
  "XAI_API_KEY", "DASHSCOPE_API_KEY", "COPILOT_API_KEY", "COPILOT_GITHUB_TOKEN",
  "CLOUDFLARE_API_TOKEN", "BRAVE_API_KEY",
]);
const SECRET_SHAPE = /(?:_API_KEY|_API_TOKEN|_CLIENT_SECRET)$/i; // provider-shaped keys + OAuth app secrets we didn't enumerate

/** True if this env var name holds one of ada's crown-jewel secrets. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV.has(key.toUpperCase()) || SECRET_SHAPE.test(key);
}

/** process.env with ada's crown-jewel secrets removed — safe to hand to a model-controlled subprocess.
 *  `extra` (e.g. an MCP server's own configured token) is layered on AFTER the scrub, so a credential
 *  the user deliberately provisioned for that server still reaches it. */
export function scrubbedEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isSecretEnvKey(k)) out[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}
