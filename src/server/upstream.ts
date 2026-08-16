// Upstream fallback: serve locally what this machine has credentials for, forward the rest.
//
// Why this exists. A Claude Pro/Max or ChatGPT plan token is personal and stays on the user's
// machine, so a hosted backend can never use it. But the desktop app talks to the hosted backend
// for everything — which made signing in to a subscription decorative: the credential was stored,
// the adapters were ready, and not one request could reach them.
//
// With an upstream configured, a LOCAL gateway becomes the front door:
//   model this machine has credentials for  -> served here, billed to the subscription
//   anything else                           -> forwarded upstream, exactly as before
//
// So the plan pays for Claude, OpenRouter models keep working, and the hosted backend keeps
// metering and quota for everything it actually serves. Unset ADA_UPSTREAM_URL and the gateway
// behaves exactly as it always did — a plain local backend that only serves what it can.

import type { IncomingMessage, ServerResponse } from "node:http";

export interface Upstream {
  url: string; // base, including /v1
  key?: string;
}

/** The backend to forward unservable requests to, or null when this is a standalone gateway. */
export function upstream(): Upstream | null {
  const url = process.env.ADA_UPSTREAM_URL?.replace(/\/+$/, "");
  if (!url) return null;
  return { url, key: process.env.ADA_UPSTREAM_KEY || undefined };
}

/** Forward a request body to the upstream backend and stream the reply back untouched. */
export async function proxyUpstream(up: Upstream, path: string, body: unknown, res: ServerResponse, signal?: AbortSignal): Promise<void> {
  let r: Awaited<ReturnType<typeof fetch>>;
  try {
    r = await fetch(`${up.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(up.key ? { authorization: `Bearer ${up.key}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `upstream ${up.url} unreachable: ${e instanceof Error ? e.message : String(e)}` } }));
    return;
  }

  // Pass the upstream's own status and content-type through: its 402 "out of quota" and 403
  // "not on your plan" carry meaning the client already knows how to render.
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
  if (!r.body) return void res.end();
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) {
        await reader.cancel(); // client gone — stop pulling (and paying for) tokens
        break;
      }
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* aborted mid-stream */
  }
  res.end();
}

/** Model ids the upstream offers, so the picker still shows everything this gateway can reach. */
export async function upstreamModels(up: Upstream): Promise<Array<{ id: string; owned_by?: string; free?: true }>> {
  try {
    const r = await fetch(`${up.url}/models`, {
      headers: up.key ? { authorization: `Bearer ${up.key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown; free?: unknown }> };
    const out: Array<{ id: string; owned_by?: string; free?: true }> = [];
    for (const m of j.data ?? []) {
      if (typeof m.id !== "string") continue;
      out.push({
        id: m.id,
        ...(typeof m.owned_by === "string" ? { owned_by: m.owned_by } : {}),
        ...(m.free === true ? { free: true as const } : {}),
      });
    }
    return out;
  } catch {
    return []; // upstream down — still list what we can serve ourselves
  }
}

/** Abort signal that fires when the client hangs up, so a proxied stream doesn't outlive it. */
export function clientAbort(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  void req;
  return ac.signal;
}
