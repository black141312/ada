// Metered usage, persisted to the database.
//
// `appendUsage` in enterprise.ts writes JSONL to the data directory, which is right for a
// self-hosted box and useless for a hosted one: Cloud Run's filesystem is ephemeral and scales to
// zero, so that file disappears regularly. Nothing can be billed or rate-limited on top of it.
// This is the same row, in Postgres (or sqlite when self-hosting), which survives a restart.
//
// What's stored is the raw fact — tokens, model, provider — not a cost. Prices change; tokens
// don't. A cost column would freeze whatever price table happened to be loaded on the day, and
// would have to be recomputed anyway the first time a provider repriced. Cost is derived at read
// time from the model id.
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./auth.js";

export interface UsageEvent {
  ts: number;
  user: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
}

const pg = () => authDatabase as Pool;
const lite = () => authDatabase as Database.Database;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    // (user_id, ts) is the only access pattern that matters: "what has this account spent this
    // period". Without the index that becomes a full scan on the busiest table in the system.
    const ddl = usingPostgres
      ? `create table if not exists usage_events (
           id bigserial primary key,
           ts bigint not null,
           user_id text not null,
           model text not null,
           provider text not null,
           prompt_tokens integer not null default 0,
           completion_tokens integer not null default 0
         )`
      : `create table if not exists usage_events (
           id integer primary key autoincrement,
           ts integer not null,
           user_id text not null,
           model text not null,
           provider text not null,
           prompt_tokens integer not null default 0,
           completion_tokens integer not null default 0
         )`;
    const idx = "create index if not exists usage_events_user_ts on usage_events (user_id, ts)";
    if (usingPostgres) {
      await pg().query(ddl);
      await pg().query(idx);
    } else {
      lite().exec(ddl);
      lite().exec(idx);
    }
  })();
  return ready;
}

/** Record one metered response. Best-effort by design — the same contract as the file writer: a
 *  metering failure must never fail the user's request. Failures are logged, not thrown, because
 *  this is called from inside a response-stream teardown where there is nobody left to catch. */
export async function recordUsage(e: UsageEvent): Promise<void> {
  try {
    await ensure();
    if (usingPostgres) {
      await pg().query(
        "insert into usage_events (ts, user_id, model, provider, prompt_tokens, completion_tokens) values ($1, $2, $3, $4, $5, $6)",
        [e.ts, e.user, e.model, e.provider, e.promptTokens, e.completionTokens],
      );
    } else {
      lite()
        .prepare("insert into usage_events (ts, user_id, model, provider, prompt_tokens, completion_tokens) values (?, ?, ?, ?, ?, ?)")
        .run(e.ts, e.user, e.model, e.provider, e.promptTokens, e.completionTokens);
    }
  } catch (err) {
    console.error("[ada] usage write failed:", err instanceof Error ? err.message : err);
  }
}

export interface UsageTotal {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

/** What one account has used since a timestamp — the number a quota is checked against. */
export async function usageSince(user: string, sinceMs: number): Promise<UsageTotal> {
  await ensure();
  const sql =
    "select coalesce(sum(prompt_tokens),0) as p, coalesce(sum(completion_tokens),0) as c, count(*) as n from usage_events where user_id = $1 and ts >= $2";
  const row = usingPostgres
    ? ((await pg().query(sql, [user, sinceMs])).rows[0] as { p: string; c: string; n: string })
    : (lite().prepare(sql.replace(/\$\d/g, "?")).get(user, sinceMs) as { p: number; c: number; n: number });
  return { promptTokens: Number(row?.p ?? 0), completionTokens: Number(row?.c ?? 0), requests: Number(row?.n ?? 0) };
}

/** Per-model breakdown for an account over a window — for a usage page, and for costing a period
 *  once a price table exists (cost needs the model, which is why it's stored per row). */
export async function usageByModel(user: string, sinceMs: number): Promise<Array<UsageTotal & { model: string }>> {
  await ensure();
  const sql =
    "select model, coalesce(sum(prompt_tokens),0) as p, coalesce(sum(completion_tokens),0) as c, count(*) as n from usage_events where user_id = $1 and ts >= $2 group by model order by n desc";
  const rows = usingPostgres
    ? ((await pg().query(sql, [user, sinceMs])).rows as Array<{ model: string; p: string; c: string; n: string }>)
    : (lite().prepare(sql.replace(/\$\d/g, "?")).all(user, sinceMs) as Array<{ model: string; p: number; c: number; n: number }>);
  return rows.map((r) => ({ model: r.model, promptTokens: Number(r.p), completionTokens: Number(r.c), requests: Number(r.n) }));
}
