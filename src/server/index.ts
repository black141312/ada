// ada backend — the Cursor-style routing layer.
// Client → here (auth → route → dispatch to an adapter) → upstream providers.
// Provider keys live ONLY here; the client never sees them.

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderName } from "../shared/types.ts";
import { PORT, PROVIDERS, clientKeys, configuredProviders, isConfigured, providerKey, providerStatus } from "./config.ts";
import { CorruptStore, type Identity, appendAudit, appendUsage, auditTail, createSeat, disableSeat, disableSeatByExternalId, enterpriseMode, extractLastUsage, identifySeat, listSeats, loadPolicy, modelAllowed, savePolicy, upsertSeatForSSO, usageSummary, validatePolicy } from "./enterprise.ts";
import { allowedUsers, isAllowed, verifyIdentity } from "./identity.ts";
import { auth, betterAuthEnabled, verifyBetterAuth } from "./auth.ts";
import { toNodeHandler } from "better-auth/node";

const betterAuthHandler = toNodeHandler(auth);

// Device sign-in page: Continue with GitHub → (return signed in) → auto-approve the code.
const DEVICE_PAGE = `<!doctype html><meta charset="utf-8"><title>Ada — sign in</title>
<body style="font-family:system-ui;background:#0d0f12;color:#c5cdd6;display:flex;justify-content:center;padding-top:14vh;margin:0">
<div style="width:320px;text-align:center">
<h2 style="color:#fff;font-weight:600">Sign in to Ada</h2>
<p style="font-size:13px;opacity:.7">Approve this device to finish signing in.</p>
<button id="gh" style="width:100%;padding:11px;margin-top:14px;border-radius:8px;border:0;background:#fff;color:#0d0f12;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
<svg width="18" height="18" viewBox="0 0 16 16" fill="#0d0f12"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
Continue with GitHub</button>
<p id="msg" style="font-size:13px;min-height:18px;margin-top:16px"></p>
</div>
<script>
const q=(s)=>document.querySelector(s); const msg=(t,ok)=>{q('#msg').textContent=t;q('#msg').style.color=ok?'#3ecf8e':'#ff6b6b'};
const code=new URLSearchParams(location.search).get('user_code')||'';
async function session(){try{const r=await fetch('/api/auth/get-session');const j=await r.json();return j&&j.user}catch{return null}}
async function approve(){ if(!code){msg('Missing device code — reopen from Ada.',false);return;} await fetch('/api/auth/device?user_code='+encodeURIComponent(code)); const r=await fetch('/api/auth/device/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userCode:code})}); if(r.ok){msg('Signed in — you can return to Ada.',true);q('#gh').style.display='none';}else{const j=await r.json().catch(()=>({}));msg('Approve failed: '+(j.message||r.status),false);} }
q('#gh').onclick=async()=>{ const u=await session(); if(u){await approve();return;} const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'github',callbackURL:location.pathname+location.search})}); const j=await r.json().catch(()=>({})); if(j.url){location.href=j.url}else{msg('Could not start GitHub sign-in.',false);} };
(async()=>{ const u=await session(); if(u&&code){ msg('Signed in as '+(u.email||u.name)+' — approving…',true); await approve(); } })();
</script></body>`;
import { assertOidcConfig, discover, isProvisionAllowed, mapIdentityToSeatFields, oidcConfig, oidcEnabled, verifyOidcToken } from "./oidc.ts";
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
  // OIDC must lock the backend the instant ADA_OIDC_ISSUER is set — BEFORE any seat exists — else a
  // fresh SSO deployment with zero seats would fall through identify() to dev-open.
  return enterpriseMode() || clientKeys() !== null || allowedUsers() !== null || oidcEnabled() || betterAuthEnabled() || !!process.env.ADA_REQUIRE_LOGIN;
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
    // Dev-open backend (nothing configured): everyone is "dev". Return NOW — before any GitHub/Google/
    // BetterAuth verification. Those are for LOCKED backends only; running them for a `dev` token just
    // to attribute an open backend is pointless and (on a slow/unreachable network) hangs the request.
    if (!locked()) return { user: "dev", role: "dev" };
    // Legacy ADA_CLIENT_KEYS are NOT honored once seats/admin-key exist — enterprise supersedes them,
    // so a disabled seat can't be resurrected via a still-configured shared key. They're ALSO refused
    // whenever OIDC is the org's IdP (single identity authority) — else a still-set shared key would
    // bypass SSO verification during the window before the first seat is minted.
    if (!oidcEnabled() && !enterpriseMode() && clientKeys()?.includes(token)) return { user: "team", role: "dev" };
    // One identity authority: when OIDC is the org's IdP, the GitHub/Google login path is disabled so
    // a person disabled in the IdP can't re-enter via a still-allowed GitHub account. (SSO users
    // authenticate at /v1/auth/oidc/exchange and then carry a seat key, not an id_token, per request.)
    if (!oidcEnabled()) {
      const id = await verifyIdentity(token); // GitHub / Google login
      if (id && isAllowed(id.user)) return { user: id.user, role: "dev" };
    }
    // Better Auth session token (accounts served at /api/auth/*) — attributed to the real user.
    // GATED on betterAuthEnabled(): the /api/auth/* signup route is always mounted (pre-auth) with
    // emailAndPassword on, so honoring these tokens unconditionally would let anyone self-register an
    // account and bypass a backend locked by seats / admin key / ADA_CLIENT_KEYS / allowlist / OIDC.
    // Accounts are a valid credential only when Better Auth is the intended gate. Allowlist applies too.
    if (betterAuthEnabled()) {
      const acct = await verifyBetterAuth(token);
      if (acct && isAllowed(acct)) return { user: acct, role: "dev" };
    }
  }
  return locked() ? null : { user: "dev", role: "dev" }; // dev mode: open
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Freemium: with ADA_FREE_TIER=1, unauthenticated requests may use `:free` models only (they cost
// nothing upstream). Signed-in users get the full catalog. Off by default — locked stays locked.
function freeTierEnabled(): boolean {
  return process.env.ADA_FREE_TIER === "1" || process.env.ADA_FREE_TIER === "true";
}
const isFreeModel = (id: string) => /:free$/i.test(id);

async function handleModels(res: ServerResponse, freeOnly = false): Promise<void> {
  const data: Array<{ id: string; object: "model"; owned_by: string }> = [];
  for (const p of configuredProviders()) {
    const ids = await adapterFor(p).listModels(p);
    for (const id of ids) {
      if (freeOnly && !isFreeModel(id)) continue;
      data.push({ id, object: "model", owned_by: p });
    }
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
  // Anonymous free tier may only touch `:free` models — everything else needs sign-in.
  if (who.user === "anon" && String(who.role) === "free" && !isFreeModel(model)) {
    return json(res, 403, { error: { message: `sign in to use ${model} — without an account only :free models are available` } });
  }

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

// Which upstream serves embeddings, and its default model. OpenRouter has no embeddings endpoint, so
// the hosted backend routes to whatever embedding-capable provider is configured. Auto-pick: an
// explicit ADA_EMBED_PROVIDER wins, else the first configured cloud embedder (Gemini free tier →
// OpenAI), else local Ollama for dev. Set ADA_EMBED_MODEL to override the model per provider.
const EMBED_DEFAULT_MODEL: Partial<Record<ProviderName, string>> = {
  google: "text-embedding-004", // Gemini, free tier, 768-dim, via Google's OpenAI-compatible endpoint
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
};
function embedProvider(): ProviderName {
  const forced = process.env.ADA_EMBED_PROVIDER as ProviderName | undefined;
  if (forced && PROVIDERS[forced]) return forced;
  if (isConfigured("google")) return "google";
  if (isConfigured("openai")) return "openai";
  return "ollama"; // keyless local dev; no-op in the cloud where it isn't reachable
}

/** Embeddings for @codebase semantic search — forwarded to a configured embedding provider
 *  (Gemini/OpenAI in the cloud, Ollama locally). Subject to the same org model allowlist as chat,
 *  and metered/attributed. */
async function handleEmbeddings(req: IncomingMessage, res: ServerResponse, who: Identity): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body" } });
  }
  const provider = embedProvider();
  // The client may send a model name tied to a different provider (e.g. the local default
  // nomic-embed-text). Substitute this provider's embedding model so the upstream call is valid.
  const model = process.env.ADA_EMBED_MODEL || EMBED_DEFAULT_MODEL[provider] || String(body.model ?? "");
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
  if (provider !== "ollama" && !providerKey(provider)) {
    return json(res, 503, { error: { message: `semantic search needs an embedding provider — set a key for '${provider}' (e.g. GEMINI_API_KEY) on the backend` } });
  }
  const key = providerKey(provider);
  const upstream = await fetch(`${PROVIDERS[provider].baseURL}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ ...body, model }),
  });
  const text = await upstream.text();
  const u = extractLastUsage(text); // embedding responses report prompt_tokens
  if (u) appendUsage({ ts: Date.now(), user: who.user, model, provider, promptTokens: u.promptTokens, completionTokens: 0 });
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(text);
}

/** Public: advertise enabled login methods so the terminal client can self-configure (no OIDC env on
 *  the client). For OIDC it returns the issuer + client id + device/token endpoints (all public
 *  discovery values) plus the exchange path. Unauthenticated by design. */
async function handleAuthMethods(res: ServerResponse): Promise<void> {
  const methods: string[] = [];
  const out: Record<string, unknown> = {};
  if (oidcEnabled()) {
    try {
      const cfg = oidcConfig();
      const d = await discover();
      if (d.device_authorization_endpoint && d.token_endpoint) {
        methods.push("oidc");
        out.oidc = {
          issuer: cfg.issuer,
          clientId: cfg.clientId,
          deviceAuthEndpoint: d.device_authorization_endpoint,
          tokenEndpoint: d.token_endpoint,
          scope: cfg.scope,
          exchangePath: "/v1/auth/oidc/exchange",
        };
      } else {
        out.oidcError = "IdP does not advertise a device_authorization_endpoint (device flow unavailable)";
      }
    } catch (e) {
      out.oidcError = e instanceof Error ? e.message : String(e);
    }
  }
  return json(res, 200, { methods, ...out });
}

/** Public: exchange a verified OIDC id_token for a seat key (model B — the id_token is a one-time
 *  provisioning artifact; every later request carries the returned ada_sk_ seat key). This is the
 *  ONLY endpoint that accepts a JWT, so an id_token never reaches the per-request seat/identity path. */
async function handleOidcExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!oidcEnabled()) return json(res, 404, { error: { message: "OIDC not enabled" } });
  const h = req.headers["authorization"];
  const idToken = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!idToken) return json(res, 401, { error: { message: "missing id_token bearer" } });

  let identity: Awaited<ReturnType<typeof verifyOidcToken>>;
  try {
    identity = await verifyOidcToken(idToken);
  } catch {
    identity = null;
  }
  if (!identity) return json(res, 401, { error: { message: "invalid or unverifiable id_token" } });

  if (!isProvisionAllowed(identity)) {
    appendAudit({ ts: Date.now(), user: identity.email ?? identity.sub, event: "sso_login_denied", detail: `not in allowed group/domain: ${identity.iss}#${identity.sub}` });
    return json(res, 403, { error: { message: "not authorized by org group/domain policy" } });
  }

  const { externalId, iss, name, role } = mapIdentityToSeatFields(identity);
  let key: string | null;
  try {
    key = upsertSeatForSSO(externalId, iss, name, role);
  } catch (e) {
    if (e instanceof CorruptStore) return json(res, 503, { error: { message: "seat store unreadable — refusing to provision (fail-closed)" } });
    throw e;
  }
  if (!key) {
    appendAudit({ ts: Date.now(), user: name, event: "sso_login_denied", detail: `seat disabled: ${externalId}` });
    return json(res, 403, { error: { message: "your seat has been disabled — contact your admin" } });
  }
  appendAudit({ ts: Date.now(), user: name, event: "sso_login", detail: externalId });
  return json(res, 200, { seat_key: key, user: name, role });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ada backend ok");
    }
    // Pre-auth login routes (a locked backend must still let a new user authenticate).
    if (req.method === "GET" && url.pathname === "/v1/auth/methods") return await handleAuthMethods(res);
    if (req.method === "POST" && url.pathname === "/v1/auth/oidc/exchange") return await handleOidcExchange(req, res);
    // Better Auth: accounts, sessions, social login, API keys, device flow.
    if (url.pathname.startsWith("/api/auth")) return betterAuthHandler(req, res);
    // Device-flow approval page (the verification_uri the CLI prints).
    if (req.method === "GET" && url.pathname === "/device") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(DEVICE_PAGE);
    }

    let who = await identify(req);
    if (who === "corrupt") return json(res, 503, { error: { message: "auth store unreadable — refusing all requests (fail-closed). Fix ~/.ada/server/users.json." } });
    if (!who && freeTierEnabled()) {
      // Anonymous free tier: models list (free subset) + chat on `:free` models only. Everything
      // else still requires sign-in — enforced below via the "free" role.
      if ((req.method === "GET" && url.pathname === "/v1/models") || (req.method === "POST" && url.pathname === "/v1/chat/completions")) {
        who = { user: "anon", role: "free" as never };
      }
    }
    if (!who) return json(res, 401, { error: { message: "unauthorized — invalid client key, seat key, or login" } });
    const isAnon = who.user === "anon" && String(who.role) === "free";

    if (req.method === "GET" && url.pathname === "/v1/whoami") {
      return json(res, 200, { ok: true, user: who.user, role: who.role });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return await handleModels(res, isAnon);
    }
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      // Which services this backend can route to, and how each is configured. Ollama is keyless so
      // "configured" says nothing — probe it (fast, localhost) so clients can show "not running".
      const list: Array<Record<string, unknown>> = providerStatus();
      const o = list.find((p) => p.name === "ollama");
      if (o) {
        o.reachable = await fetch(`${PROVIDERS.ollama.baseURL}/models`, { signal: AbortSignal.timeout(700) }).then((r) => r.ok, () => false);
      }
      return json(res, 200, { providers: list });
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
    // Immediate offboarding by OIDC externalId (`iss#sub`) — the entry point an admin (or Stage-3
    // SCIM) uses to kill a leaver's access without waiting for the id_token to expire.
    if (req.method === "POST" && url.pathname === "/v1/users/disable-by-external") {
      if (who.role !== "admin") return json(res, 403, { error: { message: "admin only" } });
      let externalId = "";
      try {
        externalId = String((JSON.parse(await readBody(req)) as { externalId?: string }).externalId ?? "").trim();
      } catch {
        /* falls through to the empty check */
      }
      if (!externalId) return json(res, 400, { error: { message: "missing 'externalId' (iss#sub)" } });
      let name: string | null;
      try {
        name = disableSeatByExternalId(externalId);
      } catch (e) {
        if (e instanceof CorruptStore) return json(res, 503, { error: { message: "seat store unreadable" } });
        throw e;
      }
      return json(res, name ? 200 : 404, name ? { ok: true, disabled: name } : { error: { message: "no seat for that externalId" } });
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
}

/** Build the ada backend HTTP server WITHOUT listening — for embedding, tests, and the hosted control
 *  plane to WRAP (it sits in front over HTTP and proxies, adding tenancy/billing). Validates OIDC
 *  config (throws on misconfig — never construct a server that would provision seats unsafely). */
export function createAdaServer(): Server {
  assertOidcConfig();
  return createServer(handleRequest);
}

/** Construct the server and listen — the `ada-server` entrypoint (called by bin/ada-server.mjs). */
export function startAdaServer(port: number = PORT): Server {
  let server: Server;
  try {
    server = createAdaServer();
  } catch (e) {
    console.error(`\x1b[31m[fatal] OIDC misconfigured: ${e instanceof Error ? e.message : e}\x1b[0m`);
    process.exit(1);
  }
  server.listen(port, () => {
    if ((enterpriseMode() || oidcEnabled()) && clientKeys()) console.warn("\x1b[33m[warn] ADA_CLIENT_KEYS is set but ignored in enterprise/OIDC mode (seats/SSO supersede it) — unset it to avoid confusion.\x1b[0m");
    const seats = listSeats().filter((s) => !s.disabled).length;
    const sso = oidcEnabled() ? " + OIDC SSO" : "";
    const auth = enterpriseMode()
      ? `ENTERPRISE (${seats} seat${seats === 1 ? "" : "s"}${process.env.ADA_ADMIN_KEY ? " + admin key" : ""}${sso})`
      : oidcEnabled()
        ? `OIDC SSO (0 seats — awaiting first login)`
        : locked()
          ? `auth ON (client keys + GitHub/Google login${allowedUsers() ? `, allowlist: ${allowedUsers()!.length}` : ""})`
          : "AUTH DISABLED (dev) — set ADA_CLIENT_KEYS or ADA_ADMIN_KEY to lock down";
    const provs = configuredProviders();
    console.log(`ada backend → http://localhost:${port}  [${auth}]`);
    console.log(`providers: ${provs.length ? provs.join(", ") : "(none configured — set provider API keys)"}`);
  });
  return server;
}
