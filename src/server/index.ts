// ada backend — the Cursor-style routing layer.
// Client → here (auth → route → dispatch to an adapter) → upstream providers.
// Provider keys live ONLY here; the client never sees them.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PORT, PROVIDERS, clientKeys, configuredProviders, isConfigured } from "./config.ts";
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
  return clientKeys() !== null || allowedUsers() !== null || !!process.env.ADA_REQUIRE_LOGIN;
}

/** A request is allowed if it carries a known static client key, OR a valid GitHub/Google
 *  login token (allowlisted). With nothing configured, the backend is open (dev mode). */
async function authorized(req: IncomingMessage): Promise<boolean> {
  if (!locked()) return true; // dev mode: no auth configured
  const h = req.headers["authorization"];
  const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return false;
  const keys = clientKeys();
  if (keys?.includes(token)) return true; // static client key
  const id = await verifyIdentity(token); // GitHub / Google login
  return !!id && isAllowed(id.user);
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

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body" } });
  }

  const model = String(body.model ?? "");
  if (!model) return json(res, 400, { error: { message: "missing 'model'" } });

  const provider = route(model, typeof body.provider === "string" ? body.provider : undefined);
  if (!isConfigured(provider)) {
    return json(res, 400, {
      error: { message: `provider '${provider}' not configured — set ${PROVIDERS[provider].keyEnv} on the backend` },
    });
  }

  delete body.provider; // our routing hint; never forward it upstream
  await adapterFor(provider).chat({ provider, model, body, res });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ada backend ok");
    }
    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      if (!(await authorized(req))) return json(res, 401, { error: { message: "not logged in" } });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!(await authorized(req))) return json(res, 401, { error: { message: "unauthorized — invalid client key or login" } });
      return await handleModels(res);
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!(await authorized(req))) return json(res, 401, { error: { message: "unauthorized — invalid client key or login" } });
      return await handleChat(req, res);
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
  const auth = locked()
    ? `auth ON (client keys + GitHub/Google login${allowedUsers() ? `, allowlist: ${allowedUsers()!.length}` : ""})`
    : "AUTH DISABLED (dev) — set ADA_CLIENT_KEYS or ADA_ALLOWED_USERS to lock down";
  const provs = configuredProviders();
  console.log(`ada backend → http://localhost:${PORT}  [${auth}]`);
  console.log(`providers: ${provs.length ? provs.join(", ") : "(none configured — set provider API keys)"}`);
});
