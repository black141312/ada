// D1-backed control-plane store for the Worker backend — the edge equivalent of the Node
// enterprise.ts (seats / policy / usage), strongly consistent via D1 SQL. Schema in schema.sql.
//
// Auth is prototype-safe by construction: seat lookup is a parameterized `WHERE key = ?` bind, so a
// token like "__proto__" is just a string that matches no row. Admin compare is constant-time.

export interface Identity {
  user: string;
  role: "admin" | "dev";
}
export interface Policy {
  models?: string[];
  permissions?: Array<{ tool?: string; pattern?: string; action: "allow" | "ask" | "deny" }>;
}

interface Env {
  DB: D1Database;
  ADA_ADMIN_KEY?: string;
}

/** Constant-time string compare (Workers has no crypto.timingSafeEqual). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve a bearer token → identity, or null. Admin key (env) first, then the seats table. */
export async function identifySeat(env: Env, token: string): Promise<Identity | null> {
  const admin = env.ADA_ADMIN_KEY;
  if (admin && ctEqual(token, admin)) return { user: "admin", role: "admin" };
  if (!token.startsWith("ada_sk_")) return null; // format guard
  const row = await env.DB.prepare("SELECT name, role, disabled FROM seats WHERE key = ?1").bind(token).first<{ name: string; role: string; disabled: number }>();
  if (!row || row.disabled) return null;
  return { user: row.name, role: row.role === "admin" ? "admin" : "dev" };
}

export async function createSeat(env: Env, name: string, role: "admin" | "dev"): Promise<string> {
  const key = "ada_sk_" + hex(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("INSERT INTO seats (key, name, role, disabled, created) VALUES (?1, ?2, ?3, 0, ?4)")
    .bind(key, name, role, new Date().toISOString()).run();
  await appendAudit(env, { ts: Date.now(), user: "-", event: "seat_created", detail: `${name} (${role})` });
  return key;
}

export async function listSeats(env: Env): Promise<Array<{ name: string; role: string; disabled: number; created: string; keyPrefix: string }>> {
  const { results } = await env.DB.prepare("SELECT key, name, role, disabled, created FROM seats ORDER BY created").all<{ key: string; name: string; role: string; disabled: number; created: string }>();
  return (results ?? []).map((r) => ({ name: r.name, role: r.role, disabled: r.disabled, created: r.created, keyPrefix: r.key.slice(0, 14) }));
}

export async function disableSeat(env: Env, prefix: string): Promise<string | null> {
  if (prefix.length < 12) return null;
  const rows = await env.DB.prepare("SELECT key, name FROM seats WHERE key LIKE ?1").bind(prefix + "%").all<{ key: string; name: string }>();
  if ((rows.results?.length ?? 0) !== 1) return null;
  const seat = rows.results![0]!;
  await env.DB.prepare("UPDATE seats SET disabled = 1 WHERE key = ?1").bind(seat.key).run();
  await appendAudit(env, { ts: Date.now(), user: "-", event: "seat_disabled", detail: seat.name });
  return seat.name;
}

export async function loadPolicy(env: Env): Promise<Policy> {
  const row = await env.DB.prepare("SELECT json FROM policy WHERE id = 1").first<{ json: string }>();
  if (!row) return {};
  try {
    return JSON.parse(row.json) as Policy;
  } catch {
    return {}; // a corrupt single row shouldn't wedge routing; treat as no-allowlist
  }
}

export async function savePolicy(env: Env, p: Policy): Promise<void> {
  await env.DB.prepare("INSERT INTO policy (id, json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET json = ?1").bind(JSON.stringify(p)).run();
  await appendAudit(env, { ts: Date.now(), user: "-", event: "policy_updated", detail: JSON.stringify(p).slice(0, 300) });
}

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(s);
}

export function modelAllowed(model: string, policy: Policy): boolean {
  if (!Array.isArray(policy.models) || !policy.models.length) return true;
  return policy.models.some((p) => globMatch(p, model));
}

export interface UsageRow { ts: number; user: string; model: string; provider: string; promptTokens: number; completionTokens: number }

export async function appendUsage(env: Env, r: UsageRow): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO usage (ts, user, model, provider, prompt_tokens, completion_tokens) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(r.ts, r.user, r.model, r.provider, r.promptTokens, r.completionTokens).run();
  } catch { /* metering is best-effort; never fail a request over it */ }
}

export async function appendAudit(env: Env, r: { ts: number; user: string; event: string; detail: string }): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO audit (ts, user, event, detail) VALUES (?1,?2,?3,?4)").bind(r.ts, r.user, r.event, r.detail).run();
  } catch { /* best-effort */ }
}

export async function usageSummary(env: Env, days: number): Promise<unknown> {
  const since = Date.now() - days * 86_400_000;
  const agg = async (groupBy: string): Promise<Record<string, unknown>> => {
    const { results } = await env.DB.prepare(`SELECT ${groupBy} AS k, COUNT(*) AS requests, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens FROM usage WHERE ts >= ?1 GROUP BY ${groupBy}`).bind(since).all<{ k: string; requests: number; promptTokens: number; completionTokens: number }>();
    const out: Record<string, unknown> = {};
    for (const r of results ?? []) out[r.k] = { requests: r.requests, promptTokens: r.promptTokens ?? 0, completionTokens: r.completionTokens ?? 0 };
    return out;
  };
  const totalsRow = await env.DB.prepare("SELECT COUNT(*) AS requests, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens FROM usage WHERE ts >= ?1").bind(since).first<{ requests: number; promptTokens: number; completionTokens: number }>();
  return {
    since,
    totals: { requests: totalsRow?.requests ?? 0, promptTokens: totalsRow?.promptTokens ?? 0, completionTokens: totalsRow?.completionTokens ?? 0 },
    byUser: await agg("user"),
    byModel: await agg("model"),
  };
}

export async function seatCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM seats WHERE disabled = 0").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Pull the LAST real `"usage": {…}` object from streamed/response text (copy of enterprise.ts). */
export function extractLastUsage(text: string): { promptTokens: number; completionTokens: number } | null {
  const matchBraces = (t: string, start: number): string | null => {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
    }
    return null;
  };
  let at = text.lastIndexOf('"usage"');
  while (at >= 0) {
    const brace = text.indexOf("{", at + 7);
    const colon = text.indexOf(":", at + 7);
    if (brace >= 0 && colon >= 0 && text.slice(colon + 1, brace).trim() === "") {
      const obj = matchBraces(text, brace);
      if (obj) {
        try {
          const u = JSON.parse(obj) as { prompt_tokens?: number; completion_tokens?: number };
          if (u.prompt_tokens != null || u.completion_tokens != null) return { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };
        } catch { /* keep scanning back */ }
      }
    }
    at = text.lastIndexOf('"usage"', at - 1);
  }
  return null;
}
