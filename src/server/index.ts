// ada backend — the Cursor-style routing layer.
// Client → here (auth → route → dispatch to an adapter) → upstream providers.
// Provider keys live ONLY here; the client never sees them.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PORT, PROVIDERS, clientKeys, configuredProviders, isConfigured } from "./config.ts";
import { CorruptStore, type Identity, appendAudit, appendUsage, auditTail, createSeat, disableSeat, enterpriseMode, extractLastUsage, identifySeat, listSeats, loadPolicy, modelAllowed, savePolicy, usageSummary, validatePolicy } from "./enterprise.ts";
import { allowedUsers, isAllowed, verifyIdentity } from "./identity.ts";
import { adapterFor } from "./providers/registry.ts";
import { route } from "./router.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function locked(): boolean {
  return enterpriseMode() || clientKeys() !== null || allowedUsers() !== null || !!process.env.ADA_REQUIRE_LOGIN;
}

/** Resolve a request to WHO is making it. Order: seat key / ADA_ADMIN_KEY (enterprise), legacy
 *  static client key, GitHub/Google login. With no auth configured, the backend is open (dev mode).
 *  Returns "corrupt" if the seat store can't be read — the caller MUST 503, never fall through to
 *  dev-open. Null = unauthorized. */
async function identify(req: IncomingMessage): Promise<Identity | "corrupt" | null> {
  const h = req.headers["authorization"];
  const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token) {
    let seat: Identity | null;
    try {
      seat = identifySeat(token);
    } catch (e) {
      if (e instanceof CorruptStore) return "corrupt";
      throw e;
    }
    if (seat) return seat;
    // Legacy ADA_CLIENT_KEYS are NOT honored once seats/admin-key exist — enterprise supersedes them,
    // so a disabled seat can't be resurrected via a still-configured shared key.
    if (!enterpriseMode() && clientKeys()?.includes(token)) return { user: "team", role: "dev" };
    const id = await verifyIdentity(token); // GitHub / Google login
    if (id && isAllowed(id.user)) return { user: id.user, role: "dev" };
  }
  return locked() ? null : { user: "dev", role: "dev" }; // dev mode: open
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handleModels(res: ServerResponse): Promise<void> {
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const p of configuredProviders()) {
    const ids = await adapterFor(p).listModels(p);
    for (const id of ids) data.push({ id, object: "model", owned_by: p });
  }
  json(res, 200, { object: "list", data });
}

async function handleChat(req: IncomingMessage, res: ServerResponse, who: Identity): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body" } });
  }

  const model = String(body.model ?? "");
  if (!model) return json(res, 400, { error: { message: "missing 'model'" } });

  // Org policy: model allowlist (enterprise). Enforced server-side so a modified client can't skip it.
  let policy: import("./enterprise.ts").Policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    if (e instanceof CorruptStore) return json(res, 503, { error: { message: "org policy unreadable — refusing requests (fail-closed)" } });
    throw e;
  }
  if (!modelAllowed(model, policy)) {
    appendAudit({ ts: Date.now(), user: who.user, event: "policy_denied_model", detail: model });
    return json(res, 403, { error: { message: `model '${model}' is not allowed by org policy (allowed: ${policy.models!.join(", ")})` } });
  }

  // When an allowlist is active, IGNORE the client's `provider` hint — else a seat holder could
  // send an allowlisted model id with a different provider and leak the body to it before the
  // upstream rejects the id. Route by the model id only.
  const explicit = policy.models?.length ? undefined : typeof body.provider === "string" ? body.provider : undefined;
  const provider = route(model, explicit);
  if (!isConfigured(provider)) {
    return json(res, 400, {
      error: { message: `provider '${provider}' not configured — set ${PROVIDERS[provider].keyEnv} on the backend` },
    });
  }

  // Metering must not be client-suppressible: force the upstream to emit a usage object on streams
  // (OpenAI-compat only sends it when include_usage is set). Harmless for providers that ignore it.
  if (body.stream) body.stream_options = { ...((body.stream_options as Record<string, unknown>) ?? {}), include_usage: true };

  // Usage metering: tee the response (streamed or not) and record the last usage object the
  // upstream reported. Wrapping res keeps this in ONE place for every adapter.
  {
    let tail = "";
    const scan = (c: unknown): void => {
      if (typeof c === "string" || Buffer.isBuffer(c)) tail = (tail + c.toString()).slice(-16_384);
    };
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = ((c: never, ...a: never[]) => {
      scan(c);
      return write(c, ...a);
    }) as typeof res.write;
    res.end = ((c?: never, ...a: never[]) => {
      scan(c);
      const u = extractLastUsage(tail);
      if (u) appendUsage({ ts: Date.now(), user: who.user, model, provider, promptTokens: u.promptTokens, completionTokens: u.completionTokens });
      return end(c, ...a);
    }) as typeof res.end;
  }

  delete body.provider; // our routing hint; never forward it upstream
  await adapterFor(provider).chat({ provider, model, body, res });
}

/** Embeddings for @codebase semantic search — forwarded to the ollama provider's
 *  OpenAI-compatible endpoint (embedding models only live there for now). Subject to the same org
 *  model allowlist as chat, and metered/attributed. */
async function handleEmbeddings(req: IncomingMessage, res: ServerResponse, who: Identity): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body" } });
  }
  const model = String(body.model ?? "");
  let policy: import("./enterprise.ts").Policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    if (e instanceof CorruptStore) return json(res, 503, { error: { message: "org policy unreadable — refusing requests" } });
    throw e;
  }
  if (model && !modelAllowed(model, policy)) {
    appendAudit({ ts: Date.now(), user: who.user, event: "policy_denied_model", detail: `embeddings:${model}` });
    return json(res, 403, { error: { message: `embedding model '${model}' is not allowed by org policy` } });
  }
  const upstream = await fetch(`${PROVIDERS.ollama.baseURL}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const text = await upstream.text();
  const u = extractLastUsage(text); // embedding responses report prompt_tokens
  if (u) appendUsage({ ts: Date.now(), user: who.user, model, provider: "ollama", promptTokens: u.promptTokens, completionTokens: 0 });
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(text);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ada backend ok");
    }
    const who = await identify(req);
    if (who === "corrupt") return json(res, 503, { error: { message: "auth store unreadable — refusing all requests (fail-closed). Fix ~/.ada/server/users.json." } });
    if (!who) return json(res, 401, { error: { message: "unauthorized — invalid client key, seat key, or login" } });

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      return json(res, 200, { ok: true, user: who.user, role: who.role });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return await handleModels(res);
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return await handleChat(req, res, who);
    }
    if (req.method === "POST" && url.pathname === "/v1/embeddings") {
      return await handleEmbeddings(req, res, who);
    }

    // ---- enterprise control plane ----
    if (url.pathname === "/v1/policy") {
      if (req.method === "GET") {
        // any seat — clients fetch this and apply the tool rules locally
        let policy: unknown;
        try {
          policy = loadPolicy();
        } catch (e) {
          if (e instanceof CorruptStore) return json(res, 503, { error: { message: "org policy unreadable" } });
          throw e;
        }
        appendAudit({ ts: Date.now(), user: who.user, event: "policy_fetched", detail: "" }); // spot seats that never fetch
        return json(res, 200, policy);
      }
      if (req.method === "PUT") {
        if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: { message: "invalid JSON body" } });
        }
        const v = validatePolicy(parsed);
        if ("error" in v) return json(res, 400, { error: { message: v.error } });
        savePolicy(v.policy);
        return json(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/v1/users") {
      if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
      if (req.method === "GET") return json(res, 200, { users: listSeats() });
      if (req.method === "POST") {
        let name = "";
        let role: "admin" | "dev" = "dev";
        try {
          const b = JSON.parse(await readBody(req)) as { name?: string; role?: string };
          name = String(b.name ?? "").trim();
          if (b.role === "admin") role = "admin";
        } catch {
          /* falls through to the name check */
        }
        if (!name) return json(res, 400, { error: { message: "missing 'name'" } });
        return json(res, 200, { key: createSeat(name, role), name, role, note: "shown once — store it now" });
      }
    }
    {
      const m = req.method === "DELETE" && url.pathname.match(/^\/v1\/users\/([\w]+)$/);
      if (m) {
        if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
        const name = disableSeat(m[1]!);
        return json(res, name ? 200 : 404, name ? { ok: true, disabled: name } : { error: { message: "unknown or ambiguous key prefix (send ≥12 chars)" } });
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/usage") {
      if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
      return json(res, 200, usageSummary(Math.min(Number(url.searchParams.get("days")) || 30, 365)));
    }
    if (req.method === "GET" && url.pathname === "/v1/audit") {
      if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
      return json(res, 200, { events: auditTail(Math.min(Number(url.searchParams.get("limit")) || 200, 2000)) });
    }

    return json(res, 404, { error: { message: "not found" } });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
    else
      try {
        res.end();
      } catch {
        /* ignore */
      }
  }
});

server.listen(PORT, () => {
  if (enterpriseMode() && clientKeys()) console.warn("\x1b[33m[warn] ADA_CLIENT_KEYS is set but ignored in enterprise mode (seats supersede it) — unset it to avoid confusion.\x1b[0m");
  const seats = listSeats().filter((s) => !s.disabled).length;
  const auth = enterpriseMode()
    ? `ENTERPRISE (${seats} seat${seats === 1 ? "" : "s"}${process.env.ADA_ADMIN_KEY ? " + admin key" : ""})`
    : locked()
      ? `auth ON (client keys + GitHub/Google login${allowedUsers() ? `, allowlist: ${allowedUsers()!.length}` : ""})`
      : "AUTH DISABLED (dev) — set ADA_CLIENT_KEYS or ADA_ADMIN_KEY to lock down";
  const provs = configuredProviders();
  console.log(`ada backend → http://localhost:${PORT}  [${auth}]`);
  console.log(`providers: ${provs.length ? provs.join(", ") : "(none configured — set provider API keys)"}`);
});
