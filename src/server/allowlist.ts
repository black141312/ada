// The allow-list, persisted. ADA_ALLOWED_USERS (env) stays as the founder/admin seed —
// it can't be locked out by a bad DB write and it authorizes /v1/allowed-users. Everyone
// else lives in the `allowed_users` table, managed over the API with no redeploy.
//
// Gate semantics (unchanged when the table is empty):
//   nothing in env AND nothing in db  -> open (any authenticated user)
//   anything anywhere                 -> the union of both is the allow-list
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./auth.js";
import { allowedUsers } from "./identity.js";

type Row = { id: string; added_by: string | null; added_at: string };

const pg = () => authDatabase as Pool;
const lite = () => authDatabase as Database.Database;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    const ddl = "create table if not exists allowed_users (id text primary key, added_by text, added_at text not null)";
    if (usingPostgres) await pg().query(ddl);
    else lite().exec(ddl);
  })();
  return ready;
}

// One tiny cache so identify() doesn't pay a DB round-trip per request.
const TTL = 30_000;
let cache: { set: Set<string>; exp: number } | null = null;
export function invalidateAllowlistCache(): void {
  cache = null;
}

async function dbSet(): Promise<Set<string>> {
  if (cache && cache.exp > Date.now()) return cache.set;
  await ensure();
  const rows = usingPostgres
    ? ((await pg().query("select id from allowed_users")).rows as { id: string }[])
    : (lite().prepare("select id from allowed_users").all() as { id: string }[]);
  const set = new Set(rows.map((r) => r.id));
  cache = { set, exp: Date.now() + TTL };
  return set;
}

/** Env list OR db table; open only when both are empty. DB failure fails CLOSED for
 *  db-listed users (env-listed users are unaffected) — this list protects billing. */
export async function isAllowedUser(user: string): Promise<boolean> {
  const env = allowedUsers();
  if (env?.includes(user)) return true;
  let db: Set<string>;
  try {
    db = await dbSet();
  } catch (e) {
    console.error("[ada] allowlist db unavailable:", e instanceof Error ? e.message : e);
    return false;
  }
  if (db.has(user)) return true;
  return !env && db.size === 0;
}

export async function listAllowed(): Promise<Row[]> {
  await ensure();
  return usingPostgres
    ? ((await pg().query("select id, added_by, added_at from allowed_users order by added_at")).rows as Row[])
    : (lite().prepare("select id, added_by, added_at from allowed_users order by added_at").all() as Row[]);
}

export async function addAllowed(user: string, by: string): Promise<void> {
  await ensure();
  const at = new Date().toISOString();
  if (usingPostgres)
    await pg().query("insert into allowed_users (id, added_by, added_at) values ($1, $2, $3) on conflict (id) do nothing", [user, by, at]);
  else lite().prepare("insert or ignore into allowed_users (id, added_by, added_at) values (?, ?, ?)").run(user, by, at);
  invalidateAllowlistCache();
}

export async function removeAllowed(user: string): Promise<boolean> {
  await ensure();
  let removed: boolean;
  if (usingPostgres) removed = ((await pg().query("delete from allowed_users where id = $1", [user])).rowCount ?? 0) > 0;
  else removed = lite().prepare("delete from allowed_users where id = ?").run(user).changes > 0;
  invalidateAllowlistCache();
  return removed;
}
