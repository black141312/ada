// Typed client SDK for the ada HTTP API (started with `ada serve`). Drive ada programmatically:
//
//   import { createClient } from "ada/sdk";
//   const ada = createClient("http://localhost:8788");
//   const { text } = await ada.prompt("list the files in this project");

export interface PromptResult {
  text: string;
  usage?: string;
}

export interface AdaClient {
  /** Send a prompt; runs a fresh agent turn server-side and returns its final text. */
  prompt(text: string, opts?: { model?: string }): Promise<PromptResult>;
  /** Server health + the default model. */
  health(): Promise<{ ok: boolean; model?: string }>;
}

export function createClient(baseUrl = "http://localhost:8788"): AdaClient {
  const url = baseUrl.replace(/\/+$/, "");
  return {
    async prompt(text, opts) {
      const res = await fetch(`${url}/v1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model: opts?.model }),
      });
      if (!res.ok) throw new Error(`ada ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return (await res.json()) as PromptResult;
    },
    async health() {
      const res = await fetch(`${url}/health`);
      return (await res.json()) as { ok: boolean; model?: string };
    },
  };
}
