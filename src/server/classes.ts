/**
 * Classroom storage: a user's classes (the app's class JSON without per-user progress), an
 * unguessable share token per class, and per-user progress rows. Same shape as plans.ts: the
 * module owns its DDL, runs it once, and speaks both Postgres and SQLite.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./db.ts";
import type { Identity } from "./enterprise.ts";

// Task 2 (the HTTP handler, added to this same file) needs these; referenced here so the
// imports aren't dead code in the meantime — `noUnusedLocals` flags an unused `import type` too.
export type _Http = [IncomingMessage, ServerResponse, Identity];

const pg = () => authDatabase() as Pool;
const lite = () => authDatabase() as Database.Database;

export const BODY_LIMIT = 524_288; // 512 KB; a 10-scene class is 30–60 KB
const TOKEN_MIN = 20;

export function isClassId(id: unknown): id is string {
  return typeof id === "string" && /^cls_[a-z0-9]{8}$/.test(id);
}

export function shareUrl(token: string): string {
  return `https://adacodelabs.com/class/#${token}`;
}

/** The document as stored: never per-user progress, never the app's local sync bookkeeping. */
export function stripDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const { progress: _p, _sync: _s, mine: _m, sharedToken: _t, ...rest } = doc;
  return rest;
}

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    const ddl = [
      `create table if not exists classes (
        id text primary key,
        owner text not null,
        title text not null,
        status text not null,
        doc text not null,
        share_token text unique,
        created_at bigint not null,
        updated_at bigint not null
      )`,
      `create index if not exists classes_owner on classes (owner, updated_at)`,
      `create table if not exists class_progress (
        class_id text not null,
        user_id text not null,
        progress text not null,
        updated_at bigint not null,
        primary key (class_id, user_id)
      )`,
    ];
    for (const stmt of ddl) {
      if (usingPostgres) await pg().query(stmt);
      else lite().exec(stmt.replace(/bigint/g, "integer"));
    }
    // `create table if not exists` does nothing to a table that already exists, so an installation
    // that predates this column would silently never get it. Nullable: the owner's own row is null.
    if (usingPostgres) {
      await pg().query("alter table class_progress add column if not exists via_token text");
    } else {
      const cols = lite().prepare("pragma table_info(class_progress)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "via_token")) lite().exec("alter table class_progress add column via_token text");
    }
  })();
  return ready;
}

// One tiny query seam so every function below reads the same on both engines.
async function all<T>(sql: string, params: unknown[]): Promise<T[]> {
  if (usingPostgres) return (await pg().query(sql, params)).rows as T[];
  return lite().prepare(sql.replace(/\$\d+/g, "?")).all(...params) as T[];
}
async function run(sql: string, params: unknown[]): Promise<number> {
  if (usingPostgres) return (await pg().query(sql, params)).rowCount ?? 0;
  return lite().prepare(sql.replace(/\$\d+/g, "?")).run(...params).changes;
}
const one = async <T>(sql: string, params: unknown[]) => (await all<T>(sql, params))[0];

type Row = { id: string; owner: string; title: string; status: string; doc: string; share_token: string | null; updated_at: number | string };
type ProgressRow = { progress: string; updated_at: number | string; via_token: string | null };

export type ClassSummary = {
  id: string; title: string; status: string; updatedAt: number; sceneCount: number; mine: boolean;
  shareToken?: string; progressUpdatedAt?: number;
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v));
const sceneCount = (doc: string) => {
  try {
    const d = JSON.parse(doc) as { scenes?: unknown };
    return Array.isArray(d.scenes) ? d.scenes.length : 0;
  } catch {
    return 0;
  }
};
const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

async function ownedRow(user: string, id: string): Promise<Row | undefined> {
  if (!isClassId(id)) return undefined;
  const r = await one<Row>("select * from classes where id = $1", [id]);
  return r && r.owner === user ? r : undefined;
}

async function myProgress(user: string, id: string): Promise<unknown | null> {
  const r = await one<ProgressRow>("select progress, updated_at from class_progress where class_id = $1 and user_id = $2", [id, user]);
  return r ? parse(r.progress) : null;
}

export async function putClass(user: string, id: string, doc: unknown): Promise<{ ok: true; updatedAt: number } | { ok: false; status: 400 | 403; message: string }> {
  await ensure();
  if (!isClassId(id)) return { ok: false, status: 400, message: "bad class id" };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, status: 400, message: "missing 'doc'" };
  const d = doc as Record<string, unknown>;
  if (d.id !== id) return { ok: false, status: 400, message: "doc.id must match the path" };
  const existing = await one<Row>("select owner from classes where id = $1", [id]);
  if (existing && existing.owner !== user) return { ok: false, status: 403, message: "not your class" };
  const stored = stripDoc(d);
  const updatedAt = Number(stored.updatedAt) || Date.now();
  const title = String(stored.title || "Untitled class").slice(0, 200);
  const status = String(stored.status || "ready");
  const now = Date.now();
  await run(
    `insert into classes (id, owner, title, status, doc, share_token, created_at, updated_at) values ($1,$2,$3,$4,$5,null,$6,$7)
     on conflict (id) do update set title = excluded.title, status = excluded.status, doc = excluded.doc, updated_at = excluded.updated_at`,
    [id, user, title, status, JSON.stringify(stored), now, updatedAt],
  );
  return { ok: true, updatedAt };
}

export async function getClass(user: string, id: string): Promise<{ doc: unknown; progress: unknown | null } | null> {
  await ensure();
  const r = await ownedRow(user, id);
  if (!r) return null;
  return { doc: parse(r.doc), progress: await myProgress(user, id) };
}

export async function listClasses(user: string): Promise<ClassSummary[]> {
  await ensure();
  const mine = await all<Row>("select * from classes where owner = $1 order by updated_at desc", [user]);
  const opened = await all<Row & { p_updated_at: number | string }>(
    // $1 and $2 are both the user: SQLite positional `?` cannot reuse a parameter, so bind it twice.
    // The `via_token` check drops an opener whose token was revoked or superseded by a re-share: their
    // class_progress row still exists (and keeps their progress), but it no longer matches the live token.
    `select c.*, p.updated_at as p_updated_at from class_progress p join classes c on c.id = p.class_id
     where p.user_id = $1 and c.owner <> $2 and c.share_token is not null and p.via_token = c.share_token order by c.updated_at desc`,
    [user, user],
  );
  const out: ClassSummary[] = mine.map((r) => ({
    id: r.id, title: r.title, status: r.status, updatedAt: num(r.updated_at), sceneCount: sceneCount(r.doc), mine: true,
    ...(r.share_token ? { shareToken: r.share_token } : {}),
  }));
  for (const r of opened) {
    out.push({ id: r.id, title: r.title, status: r.status, updatedAt: num(r.updated_at), sceneCount: sceneCount(r.doc), mine: false, shareToken: r.share_token!, progressUpdatedAt: num(r.p_updated_at) });
  }
  return out;
}

export async function deleteClass(user: string, id: string): Promise<boolean> {
  await ensure();
  if (!(await ownedRow(user, id))) return false;
  await run("delete from class_progress where class_id = $1", [id]);
  return (await run("delete from classes where id = $1 and owner = $2", [id, user])) > 0;
}

export async function shareClass(user: string, id: string): Promise<{ token: string; url: string } | null> {
  await ensure();
  const r = await ownedRow(user, id);
  if (!r) return null;
  let token = r.share_token;
  if (!token) {
    token = randomBytes(16).toString("base64url");
    await run("update classes set share_token = $1 where id = $2", [token, id]);
  }
  return { token, url: shareUrl(token) };
}

export async function unshareClass(user: string, id: string): Promise<boolean> {
  await ensure();
  if (!(await ownedRow(user, id))) return false;
  await run("update classes set share_token = null where id = $1", [id]);
  return true;
}

export async function getShared(user: string, token: string): Promise<{ id: string; doc: unknown; progress: unknown | null } | null> {
  await ensure();
  if (typeof token !== "string" || token.length < TOKEN_MIN) return null;
  const r = await one<Row>("select * from classes where share_token = $1", [token]);
  if (!r) return null;
  // Remembering "this user opened it" is what puts the class in their list from now on. Re-opening
  // with the CURRENT token re-admits an opener whose access lapsed (revoke, then re-share) without
  // touching their progress — only via_token changes on conflict.
  await run(
    `insert into class_progress (class_id, user_id, progress, updated_at, via_token) values ($1,$2,'{}',0,$3)
     on conflict (class_id, user_id) do update set via_token = excluded.via_token`,
    [r.id, user, token],
  );
  return { id: r.id, doc: parse(r.doc), progress: await myProgress(user, r.id) };
}

export async function putProgress(user: string, id: string, progress: unknown): Promise<{ ok: true; stale: boolean } | { ok: false; status: 403 }> {
  await ensure();
  if (!isClassId(id) || !progress || typeof progress !== "object") return { ok: false, status: 403 };
  const r = await one<Row>("select owner, share_token from classes where id = $1", [id]);
  if (!r) return { ok: false, status: 403 };
  const cur = await one<ProgressRow>("select progress, updated_at, via_token from class_progress where class_id = $1 and user_id = $2", [id, user]);
  // An opener may push only while their row's via_token still matches the class's live share_token —
  // a revoke (share_token -> null) or a re-share to a new token (share_token changes) both cut them off
  // until they re-open with the current token, which is what refreshes via_token in getShared.
  const allowed = r.owner === user || (!!cur && cur.via_token != null && cur.via_token === r.share_token);
  if (!allowed) return { ok: false, status: 403 };
  const updatedAt = Number((progress as { updatedAt?: unknown }).updatedAt) || 0;
  if (cur && num(cur.updated_at) > updatedAt) return { ok: true, stale: true };
  await run(
    `insert into class_progress (class_id, user_id, progress, updated_at) values ($1,$2,$3,$4)
     on conflict (class_id, user_id) do update set progress = excluded.progress, updated_at = excluded.updated_at`,
    [id, user, JSON.stringify(progress), updatedAt],
  );
  return { ok: true, stale: false };
}

export async function deleteProgress(user: string, id: string): Promise<boolean> {
  await ensure();
  if (!isClassId(id)) return false;
  const r = await one<Row>("select owner from classes where id = $1", [id]);
  if (!r || r.owner === user) return false;
  return (await run("delete from class_progress where class_id = $1 and user_id = $2", [id, user])) > 0;
}
