// ada backend on Cloudflare Workers (R4 v1). A self-contained edge port of the Node routing server:
// auth (D1 seats + admin key) → org model-allowlist → provider passthrough with server-side metering.
// Cloudflare Workers AI (@cf/*) is the first-class provider. See docs/deploy.md.
//
// v1 scope: /health, /v1/models, /v1/chat/completions, /v1/embeddings, and the admin control plane
// (/v1/users, /v1/policy, /v1/usage, /v1/audit). DEFERRED (follow-ups): native Anthropic (use Claude
// via OpenRouter or a Cloudflare AI Gateway meanwhile), OIDC SSO (needs a Web Crypto port of oidc.ts).

import { providerKey, providers, route } from "./providers.ts";
import { appendAudit, appendUsage, createSeat, disableSeat, extractLastUsage, identifySeat, listSeats, loadPolicy, modelAllowed, savePolicy, seatCount, usageSummary, type Identity, type Policy } from "./store.ts";

interface Env {
  DB: D1Database;
  ADA_ADMIN_KEY?: string;
  [key: string]: unknown;
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** Tee a response stream to accumulate the upstream's reported token usage, recorded after the body
 *  drains (ctx.waitUntil). Works for streamed SSE and one-shot JSON alike. */
function meterStream(env: Env, ctx: ExecutionContext, who: Identity, model: string, provider: string, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let tail = "";
  const dec = new TextDecoder();
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      tail = (tail + dec.decode(chunk, { stream: true })).slice(-16_384);
      controller.enqueue(chunk);
    },
    flush() {
      const u = extractLastUsage(tail);
      if (u) ctx.waitUntil(appendUsage(env, { ts: Date.now(), user: who.user, model, provider, promptTokens: u.promptTokens, completionTokens: u.completionTokens }));
    },
  });
  return body.pipeThrough(ts);
}

async function proxyChat(env: Env, ctx: ExecutionContext, who: Identity, body: Record<string, unknown>): Promise<Response> {
  const model = String(body.model ?? "");
  if (!model) return json(400, { error: { message: "missing 'model'" } });

  const policy: Policy = await loadPolicy(env);
  if (!modelAllowed(model, policy)) {
    ctx.waitUntil(appendAudit(env, { ts: Date.now(), user: who.user, event: "policy_denied_model", detail: model }));
    return json(403, { error: { message: `model '${model}' is not allowed by org policy (allowed: ${policy.models!.join(", ")})` } });
  }

  // With an allowlist active, ignore the client's provider hint (route by model id only).
  const explicit = policy.models?.length ? undefined : typeof body.provider === "string" ? body.provider : undefined;
  const provider = route(model, explicit);
  const def = providers(env)[provider];
  if (provider === "anthropic" && def.baseURL.includes("api.anthropic.com")) {
    return json(400, { error: { message: "native Anthropic isn't available on the Worker backend yet — use Claude via OpenRouter (model 'anthropic/claude-…') or set CLOUDFLARE_BASE_URL to an AI Gateway." } });
  }
  const key = providerKey(env, def);
  if (def.keyEnv && !key) return json(400, { error: { message: `provider '${provider}' not configured — set the ${def.keyEnv} secret` } });

  if (body.stream) body.stream_options = { ...((body.stream_options as Record<string, unknown>) ?? {}), include_usage: true };
  const prefix = `${provider}/`;
  const outModel = typeof body.model === "string" && body.model.startsWith(prefix) ? body.model.slice(prefix.length) : body.model;
  const outBody: Record<string, unknown> = { ...body, model: outModel };
  delete outBody.provider;

  let upstream: Response;
  try {
    upstream = await fetch(`${def.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(outBody),
    });
  } catch (e) {
    return json(502, { error: { message: `could not reach ${provider}: ${e instanceof Error ? e.message : String(e)}` } });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || JSON.stringify({ error: { message: `upstream error ${upstream.status}` } }), { status: upstream.status || 502, headers: { "content-type": "application/json" } });
  }
  const metered = meterStream(env, ctx, who, model, provider, upstream.body);
  return new Response(metered, { status: 200, headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" } });
}

async function proxyEmbeddings(env: Env, ctx: ExecutionContext, who: Identity, body: Record<string, unknown>, raw: string): Promise<Response> {
  const model = String(body.model ?? "");
  const policy = await loadPolicy(env);
  if (model && !modelAllowed(model, policy)) {
    ctx.waitUntil(appendAudit(env, { ts: Date.now(), user: who.user, event: "policy_denied_model", detail: `embeddings:${model}` }));
    return json(403, { error: { message: `embedding model '${model}' is not allowed by org policy` } });
  }
  const provider = route(model);
  const def = providers(env)[provider];
  const key = providerKey(env, def);
  if (def.keyEnv && !key) return json(400, { error: { message: `provider '${provider}' not configured — set the ${def.keyEnv} secret` } });
  let upstream: Response;
  try {
    upstream = await fetch(`${def.baseURL}/embeddings`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: raw });
  } catch (e) {
    return json(502, { error: { message: `could not reach ${provider}: ${e instanceof Error ? e.message : String(e)}` } });
  }
  const text = await upstream.text();
  const u = extractLastUsage(text);
  if (u) ctx.waitUntil(appendUsage(env, { ts: Date.now(), user: who.user, model, provider, promptTokens: u.promptTokens, completionTokens: 0 }));
  return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
}

async function listModels(env: Env): Promise<Response> {
  const table = providers(env);
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  await Promise.all((Object.keys(table) as Array<keyof typeof table>).map(async (p) => {
    const def = table[p];
    const key = providerKey(env, def);
    if (def.keyEnv && !key) return; // not configured
    try {
      const r = await fetch(`${def.baseURL}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!r.ok) return;
      const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
      for (const m of j.data ?? []) if (typeof m.id === "string") data.push({ id: m.id, object: "model", owned_by: String(p) });
    } catch { /* skip a provider that errors */ }
  }));
  return json(200, { object: "list", data });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/" || path === "/health") return new Response("ada worker ok\n", { headers: { "content-type": "text/plain" } });

      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const who = token ? await identifySeat(env, token) : null;
      if (!who) return json(401, { error: { message: "unauthorized — invalid seat key or admin key" } });

      const readBody = async (): Promise<{ raw: string; body: Record<string, unknown> } | null> => {
        const raw = await request.text();
        try {
          return { raw, body: JSON.parse(raw) as Record<string, unknown> };
        } catch {
          return null;
        }
      };
      const adminOnly = (): Response | null => (who.role === "admin" ? null : json(403, { error: { message: "admin only" } }));

      if (request.method === "GET" && path === "/v1/whoami") return json(200, { ok: true, user: who.user, role: who.role });
      if (request.method === "GET" && path === "/v1/models") return await listModels(env);
      if (request.method === "POST" && path === "/v1/chat/completions") {
        const b = await readBody();
        return b ? await proxyChat(env, ctx, who, b.body) : json(400, { error: { message: "invalid JSON body" } });
      }
      if (request.method === "POST" && path === "/v1/embeddings") {
        const b = await readBody();
        return b ? await proxyEmbeddings(env, ctx, who, b.body, b.raw) : json(400, { error: { message: "invalid JSON body" } });
      }

      // ---- control plane ----
      if (path === "/v1/policy") {
        if (request.method === "GET") return json(200, await loadPolicy(env));
        if (request.method === "PUT") {
          const deny = adminOnly();
          if (deny) return deny;
          const b = await readBody();
          if (!b) return json(400, { error: { message: "invalid JSON body" } });
          const models = b.body.models;
          if (models !== undefined && (!Array.isArray(models) || models.some((m) => typeof m !== "string" || !m.trim()))) return json(400, { error: { message: "models must be an array of non-empty strings" } });
          await savePolicy(env, b.body as Policy);
          return json(200, { ok: true });
        }
      }
      if (path === "/v1/users") {
        const deny = adminOnly();
        if (deny) return deny;
        if (request.method === "GET") return json(200, { users: await listSeats(env) });
        if (request.method === "POST") {
          const b = await readBody();
          const name = String((b?.body.name as string) ?? "").trim();
          const role: "admin" | "dev" = b?.body.role === "admin" ? "admin" : "dev";
          if (!name) return json(400, { error: { message: "missing 'name'" } });
          return json(200, { key: await createSeat(env, name, role), name, role, note: "shown once — store it now" });
        }
      }
      {
        const m = request.method === "DELETE" && path.match(/^\/v1\/users\/([\w]+)$/);
        if (m) {
          const deny = adminOnly();
          if (deny) return deny;
          const name = await disableSeat(env, m[1]!);
          return json(name ? 200 : 404, name ? { ok: true, disabled: name } : { error: { message: "unknown or ambiguous key prefix (send ≥12 chars)" } });
        }
      }
      if (request.method === "GET" && path === "/v1/usage") {
        const deny = adminOnly();
        if (deny) return deny;
        return json(200, await usageSummary(env, Math.min(Number(url.searchParams.get("days")) || 30, 365)));
      }
      if (request.method === "GET" && path === "/v1/audit") {
        const deny = adminOnly();
        if (deny) return deny;
        const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 2000);
        const { results } = await env.DB.prepare("SELECT ts, user, event, detail FROM audit ORDER BY ts DESC LIMIT ?1").bind(limit).all();
        return json(200, { events: (results ?? []).reverse() });
      }
      if (request.method === "GET" && path === "/v1/enterprise") {
        return json(200, { seats: await seatCount(env), adminKey: !!env.ADA_ADMIN_KEY });
      }

      return json(404, { error: { message: "not found" } });
    } catch (err) {
      return json(500, { error: { message: err instanceof Error ? err.message : String(err) } });
    }
  },
};
