// Typed client SDK for the ada HTTP API (started with `ada serve`). Two ways to drive ada:
//
//   import { createClient } from "ada-agent/sdk"; // or "./src/sdk/index.ts" in-repo
//   const ada = createClient("http://localhost:8788");
//
// One-shot (no memory between calls — a "generate this" action, not a chat panel):
//   const { text } = await ada.prompt("list the files in this project");
//
// Interactive (a Cursor-style agent panel — persistent session, live events, edits pause for your
// own approval UI instead of auto-running):
//   const session = await ada.session();
//   await session.prompt("refactor foo.ts", (e) => {
//     if (e.type === "text") process.stdout.write(e.delta);
//     if (e.type === "tool_call") console.log(`→ ${e.name} ${e.detail}`);
//     if (e.type === "approval_request") session.approve(e.id, myOwnConfirmUi(e.name, e.summary) ? "yes" : "no");
//   });

export interface PromptResult {
  text: string;
  usage?: string;
}

/** One event from an interactive session's prompt stream. */
export type SessionEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; detail: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "approval_request"; id: string; name: string; summary: string }
  | { type: "done"; text: string; usage: string }
  | { type: "error"; message: string };

export interface AdaSession {
  readonly id: string;
  /** Send a prompt; `onEvent` fires for every event as the turn streams. Resolves once it's done. */
  prompt(text: string, onEvent: (e: SessionEvent) => void): Promise<void>;
  /** Answer a pending `approval_request` event by its id. */
  approve(id: string, decision: "yes" | "all" | "no"): Promise<void>;
  /** Free the session's resources server-side. */
  close(): Promise<void>;
}

export interface AdaClient {
  /** One-shot: runs a fresh agent turn server-side (no memory between calls) and returns its final text. */
  prompt(text: string, opts?: { model?: string }): Promise<PromptResult>;
  /** Start a persistent, streaming session — the Cursor-style integration point for an IDE. */
  session(opts?: { model?: string }): Promise<AdaSession>;
  /** Server health + the default model. */
  health(): Promise<{ ok: boolean; model?: string }>;
}

async function streamSse(res: Response, onEvent: (e: SessionEvent) => void): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`ada ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as SessionEvent);
    }
  }
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
    async session(opts) {
      const res = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts?.model }),
      });
      if (!res.ok) throw new Error(`ada ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      const { sessionId } = (await res.json()) as { sessionId: string };
      return {
        id: sessionId,
        async prompt(text, onEvent) {
          const r = await fetch(`${url}/v1/sessions/${sessionId}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          await streamSse(r, onEvent);
        },
        async approve(id, decision) {
          const r = await fetch(`${url}/v1/sessions/${sessionId}/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, decision }),
          });
          if (!r.ok) throw new Error(`ada ${r.status}: could not settle approval ${id}`);
        },
        async close() {
          await fetch(`${url}/v1/sessions/${sessionId}`, { method: "DELETE" });
        },
      };
    },
    async health() {
      const res = await fetch(`${url}/health`);
      return (await res.json()) as { ok: boolean; model?: string };
    },
  };
}
