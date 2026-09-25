/**
 * Coaching institutes (Ada Tutor): an institute pays for its students' doubts.
 *
 * A request that names an institute (`x-ada-institute`, set by the Cloudflare Worker from the
 * subdomain — it overwrites anything the browser sent) is paid for by that institute only when it
 * asks for the institute's own model and carries a doubt id (`x-ada-doubt`) to count against the
 * student's daily cap. Anything else — another model, no doubt id, an unknown or inactive
 * institute — falls through to the student's own plan exactly as before.
 *
 * Same shape as plans.ts/classes.ts: the module owns its DDL, runs it once, speaks Postgres and SQLite.
 */
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./db.ts";
import { planFor } from "./plans.ts";

const pg = () => authDatabase() as Pool;
const lite = () => authDatabase() as Database.Database;

export interface Institute {
  slug: string;
  name: string;
  logoUrl: string | null;
  /** The one model the institute pays for. Exact id, compared exactly. */
  model: string;
  dailyDoubtsPerStudent: number;
  active: boolean;
}

/** The pilot, created on first boot if absent. Haiku via OpenRouter — the hosted backend's key. */
export const DEMO: Institute = {
  slug: "demo",
  name: "Demo Coaching",
  logoUrl: null,
  model: "anthropic/claude-haiku-4.5",
  dailyDoubtsPerStudent: 30,
  active: true,
};

/** Model calls one doubt id may make per day on the institute's bill. A doubt is an outline, 2–4
 *  scenes, a couple of repairs each and some follow-ups — ~15–30 calls. Without a ceiling one doubt
 *  id, reused forever, would be unlimited free Haiku. ponytail: flat per-doubt ceiling; per-institute
 *  budgets are part 5. */
export const CALLS_PER_DOUBT = 60;

export const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s);
/** Same format the app mints for classes (classes.ts isClassId) — a doubt is a class doc. */
export const isDoubtId = (s: unknown): s is string => typeof s === "string" && /^cls_[a-z0-9]{8}$/.test(s);

/** Doubt caps reset at UTC midnight (05:30 IST — nobody is studying then). */
export const dayOf = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    const ddl = [
      `create table if not exists institutes (
        slug text primary key,
        name text not null,
        logo_url text,
        model text not null,
        daily_doubts_per_student integer not null,
        active boolean not null default true,
        created_at bigint not null
      )`,
      // ponytail: open join — anyone signed in who uses the subdomain becomes a member. Part 3 adds
      // invite / email-domain rules; this table is where they'll be checked.
      `create table if not exists institute_members (
        slug text not null,
        user_id text not null,
        first_seen bigint not null,
        primary key (slug, user_id)
      )`,
      // One row per (student, day, doubt): the cap counts rows, `calls` bounds a single doubt.
      `create table if not exists institute_doubts (
        slug text not null,
        user_id text not null,
        day text not null,
        doubt_id text not null,
        calls integer not null default 0,
        first_at bigint not null,
        primary key (slug, user_id, day, doubt_id)
      )`,
    ];
    for (const stmt of ddl) {
      if (usingPostgres) await pg().query(stmt);
      else lite().exec(stmt.replace(/bigint/g, "integer"));
    }
    await run(
      `insert into institutes (slug, name, logo_url, model, daily_doubts_per_student, active, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (slug) do nothing`,
      [DEMO.slug, DEMO.name, DEMO.logoUrl, DEMO.model, DEMO.dailyDoubtsPerStudent, usingPostgres ? true : 1, Date.now()],
    );
  })().catch((e) => {
    ready = null; // a concurrent first-run race is transient — let the next request retry
    throw e;
  });
  return ready;
}

async function all<T>(sql: string, params: unknown[]): Promise<T[]> {
  if (usingPostgres) return (await pg().query(sql, params)).rows as T[];
  return lite().prepare(sql.replace(/\$\d+/g, "?")).all(...params) as T[];
}
async function run(sql: string, params: unknown[]): Promise<number> {
  if (usingPostgres) return (await pg().query(sql, params)).rowCount ?? 0;
  return lite().prepare(sql.replace(/\$\d+/g, "?")).run(...params).changes;
}

type Row = { slug: string; name: string; logo_url: string | null; model: string; daily_doubts_per_student: number | string; active: boolean | number };
const fromRow = (r: Row): Institute => ({
  slug: r.slug,
  name: r.name,
  logoUrl: r.logo_url,
  model: r.model,
  dailyDoubtsPerStudent: Number(r.daily_doubts_per_student),
  active: r.active === true || r.active === 1,
});

/** An institute by slug, active or not. Null when there's no such row. */
export async function getInstitute(slug: string): Promise<Institute | null> {
  if (!isSlug(slug)) return null;
  await ensure();
  const r = (await all<Row>("select slug, name, logo_url, model, daily_doubts_per_student, active from institutes where slug = $1", [slug]))[0];
  return r ? fromRow(r) : null;
}

/** Create or replace an institute. Admin CRUD is part 3; this is what it (and the tests) call. */
export async function putInstitute(i: Institute): Promise<void> {
  await ensure();
  await run(
    `insert into institutes (slug, name, logo_url, model, daily_doubts_per_student, active, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (slug) do update set name = excluded.name, logo_url = excluded.logo_url, model = excluded.model,
       daily_doubts_per_student = excluded.daily_doubts_per_student, active = excluded.active`,
    [i.slug, i.name, i.logoUrl, i.model, i.dailyDoubtsPerStudent, usingPostgres ? i.active : i.active ? 1 : 0, Date.now()],
  );
}

/** Idempotent: the first use of an institute makes the user a member. */
export async function ensureMember(slug: string, user: string): Promise<void> {
  await ensure();
  await run("insert into institute_members (slug, user_id, first_seen) values ($1, $2, $3) on conflict (slug, user_id) do nothing", [slug, user, Date.now()]);
}

export async function isMember(slug: string, user: string): Promise<boolean> {
  await ensure();
  return (await all("select 1 from institute_members where slug = $1 and user_id = $2", [slug, user])).length > 0;
}

export interface DoubtStats {
  /** Distinct doubts this student has asked this institute today. */
  doubtsToday: number;
  /** Model calls already made under this doubt id today; null when this doubt is new today. */
  doubtCalls: number | null;
}

const STATS_SQL = "select doubt_id, calls from institute_doubts where slug = $1 and user_id = $2 and day = $3";
const RECORD_SQL = `insert into institute_doubts (slug, user_id, day, doubt_id, calls, first_at) values ($1, $2, $3, $4, 1, $5)
  on conflict (slug, user_id, day, doubt_id) do update set calls = institute_doubts.calls + 1`;
const toStats = (rows: Array<{ doubt_id: string; calls: number | string }>, doubtId: string): DoubtStats => {
  const mine = rows.find((r) => r.doubt_id === doubtId);
  return { doubtsToday: rows.length, doubtCalls: mine ? Number(mine.calls) : null };
};

export async function doubtStats(slug: string, user: string, day: string, doubtId: string): Promise<DoubtStats> {
  await ensure();
  return toStats(await all(STATS_SQL, [slug, user, day]), doubtId);
}

/** Read the student's counts, decide, and — only on a waiver — count the call, as ONE atomic step.
 *  A read-then-write gate let N parallel requests with fresh doubt ids all see "under the cap".
 *  Postgres: a transaction holding an advisory lock on (institute, student, day), so every instance
 *  queues on the same key. SQLite: one synchronous IMMEDIATE transaction (writes are serialized). */
export async function claimDoubtCall(
  slug: string,
  user: string,
  day: string,
  doubtId: string,
  decide: (s: DoubtStats) => InstituteDecision,
): Promise<InstituteDecision> {
  await ensure();
  const params = [slug, user, day];
  if (!usingPostgres) {
    const db = lite();
    return db
      .transaction(() => {
        const d = decide(toStats(db.prepare(STATS_SQL.replace(/\$\d+/g, "?")).all(...params) as Array<{ doubt_id: string; calls: number }>, doubtId));
        if (d.kind === "waive") db.prepare(RECORD_SQL.replace(/\$\d+/g, "?")).run(slug, user, day, doubtId, Date.now());
        return d;
      })
      .immediate();
  }
  const client = await pg().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`institute-doubts|${slug}|${user}|${day}`]);
    const d = decide(toStats((await client.query(STATS_SQL, params)).rows, doubtId));
    if (d.kind === "waive") await client.query(RECORD_SQL, [slug, user, day, doubtId, Date.now()]);
    await client.query("commit");
    return d;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- the waived request body ----------

/** A waived call is the institute's money, so its body is cut down to what a doubt needs. The chat
 *  adapters forward the client's body as-is, and on OpenRouter that body can pick other models
 *  (`models`, `route`), add paid features (`plugins` — web search, PDF OCR; `transforms`;
 *  `web_search_options`), multiply the output (`n`), or buy extra thinking (`reasoning`,
 *  `reasoning_effort`, `verbosity`). An allowlist, not a denylist, so a field OpenRouter adds next
 *  month is dropped by default. */
export const WAIVED_BODY_LIMIT = 2 * 1024 * 1024;
export const WAIVED_MAX_TOKENS = 8192;
const WAIVED_KEEP = ["model", "messages", "stream", "stream_options", "temperature", "top_p", "stop", "response_format", "seed", "presence_penalty", "frequency_penalty"];

/** Why this body can't be waived, or null. Text and images only: a `file` part is how a PDF gets in,
 *  and PDFs are where OpenRouter's paid parsing engines come in. */
export function waivedBodyProblem(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.messages)) return "'messages' must be an array";
  for (const m of body.messages as Array<{ content?: unknown }>) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content as Array<{ type?: unknown }>) {
      if (p?.type !== "text" && p?.type !== "image_url") return "institute doubts accept text and images only";
    }
  }
  return null;
}

export function sanitizeWaivedBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WAIVED_KEEP) if (k in body) out[k] = body[k];
  const asked = [body.max_tokens, body.max_completion_tokens].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1);
  out.max_tokens = Math.min(WAIVED_MAX_TOKENS, ...asked.map(Math.floor));
  return out;
}

// ---------- the decision (pure) ----------

export type InstituteDecision =
  /** Not an institute request, or one the institute doesn't pay for: today's rules apply. */
  | { kind: "none" }
  /** The institute pays: skip the student's price gate, count the call against the doubt. */
  | { kind: "waive"; slug: string; doubtId: string; newDoubt: boolean }
  | { kind: "deny"; status: 400 | 403 | 413 | 429; message: string };

export interface DecisionInput {
  /** Validated x-ada-institute, or null. */
  slug: string | null;
  /** The institute that slug names, or null if none. */
  institute: Institute | null;
  model: string;
  /** Validated x-ada-doubt, or null. */
  doubtId: string | null;
  banned: boolean;
  /** Raw request body size, and waivedBodyProblem() of it. */
  bodyBytes: number;
  bodyProblem: string | null;
  stats: DoubtStats;
}

export const DAILY_LIMIT_MESSAGE = "Daily doubt limit reached";
export const DOUBT_LIMIT_MESSAGE = "This doubt has reached its limit — ask a new doubt to continue";

/** The whole institute rule, kept pure so every branch is tested without a database.
 *  The waiver needs ALL of: an active institute, the request asking for exactly that institute's
 *  model, and a doubt id to count. Missing any one → "none", which is the student's own plan. */
export function decideInstitute(i: DecisionInput): InstituteDecision {
  if (!i.slug || !i.institute || !i.institute.active || i.institute.slug !== i.slug) return { kind: "none" };
  if (i.model !== i.institute.model) return { kind: "none" };
  if (!i.doubtId) return { kind: "none" };
  if (i.banned) return { kind: "deny", status: 403, message: "This account is suspended." };
  if (i.bodyBytes > WAIVED_BODY_LIMIT) return { kind: "deny", status: 413, message: "doubt too large (2 MB max) — use a smaller photo" };
  if (i.bodyProblem) return { kind: "deny", status: 400, message: i.bodyProblem };
  const isNew = i.stats.doubtCalls === null;
  if (isNew && i.stats.doubtsToday >= i.institute.dailyDoubtsPerStudent) return { kind: "deny", status: 429, message: DAILY_LIMIT_MESSAGE };
  if (!isNew && i.stats.doubtCalls! >= CALLS_PER_DOUBT) return { kind: "deny", status: 429, message: DOUBT_LIMIT_MESSAGE };
  return { kind: "waive", slug: i.slug, doubtId: i.doubtId, newDoubt: isNew };
}

// ---------- the gate (decision + stores) ----------

export interface InstituteStore {
  getInstitute(slug: string): Promise<Institute | null>;
  ensureMember(slug: string, user: string): Promise<void>;
  isBanned(user: string): Promise<boolean>;
  /** Atomic read-decide-record (see claimDoubtCall). */
  claimDoubtCall(slug: string, user: string, day: string, doubtId: string, decide: (s: DoubtStats) => InstituteDecision): Promise<InstituteDecision>;
}

const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : null;
};

/** Read the two headers, look everything up, and decide — counting the call atomically when the
 *  institute pays. `body` is the request (raw size + parsed) for the waived-body checks. */
export async function instituteGate(
  store: InstituteStore,
  req: IncomingMessage,
  user: string,
  model: string,
  body: { bytes: number; parsed: Record<string, unknown> },
  now = Date.now(),
): Promise<InstituteDecision> {
  const rawSlug = header(req, "x-ada-institute");
  const slug = isSlug(rawSlug) ? rawSlug : null;
  if (!slug) return { kind: "none" };
  const institute = await store.getInstitute(slug);
  if (!institute?.active) return { kind: "none" };
  await store.ensureMember(slug, user);
  const rawDoubt = header(req, "x-ada-doubt");
  const doubtId = isDoubtId(rawDoubt) ? rawDoubt : null;
  // Only look further when the answer could be a waiver — everything else is the student's plan.
  if (model !== institute.model || !doubtId) return { kind: "none" };
  const banned = await store.isBanned(user);
  const bodyProblem = waivedBodyProblem(body.parsed);
  return store.claimDoubtCall(slug, user, dayOf(now), doubtId, (stats) =>
    decideInstitute({ slug, institute, model, doubtId, banned, bodyBytes: body.bytes, bodyProblem, stats }),
  );
}

/** The database-backed store. A ban lives on the plan row. */
export const dbStore: InstituteStore = {
  getInstitute,
  ensureMember,
  claimDoubtCall,
  isBanned: async (user) => (await planFor(user)).status === "banned",
};

/** Public branding for the student site: never the model or the cap. */
export async function publicInstitute(slug: string): Promise<{ slug: string; name: string; logoUrl: string | null } | null> {
  const i = await getInstitute(slug);
  return i?.active ? { slug: i.slug, name: i.name, logoUrl: i.logoUrl } : null;
}
