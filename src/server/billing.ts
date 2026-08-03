// Checkout sessions: the handoff that lets a static website act on behalf of a signed-in app user
// without ever seeing their credentials.
//
// The obvious shortcut is to open the site with the account token in the query string. That token
// is a full credential — it lands in browser history, in the Referer header of every third-party
// asset the page loads, and in any analytics the site ever adds. So instead the app asks the
// backend (authenticated) to mint a session; the app opens a URL carrying only that session's id.
//
// The id is a 256-bit random value and is all the site needs, because reading a session tells you
// nothing but which plan is being bought and which email it is for. It cannot be used to call the
// API, cannot be replayed after it is spent, and expires on its own.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./auth.js";
import { PLANS, setPlan, type PlanName } from "./plans.js";

/** Long enough that a user can finish a payment flow, short enough that a leaked link goes stale. */
const TTL_MS = 30 * 60_000;

export interface CheckoutSession {
  id: string;
  user: string;
  plan: PlanName;
  status: "pending" | "paid" | "expired";
  createdAt: number;
  expiresAt: number;
}

const pg = () => authDatabase as Pool;
const lite = () => authDatabase as Database.Database;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    const ddl = `create table if not exists checkout_sessions (
      id text primary key,
      user_id text not null,
      plan text not null,
      status text not null default 'pending',
      created_at bigint not null,
      expires_at bigint not null
    )`;
    if (usingPostgres) await pg().query(ddl);
    else lite().exec(ddl.replace(/bigint/g, "integer"));
  })();
  return ready;
}

/** Mint a session for an authenticated user. The caller must already have identified them — this
 *  function trusts `user` completely, so it must never be reachable from an unauthenticated route. */
export async function createCheckout(user: string, plan: PlanName): Promise<CheckoutSession> {
  if (!(plan in PLANS)) throw new Error(`unknown plan '${plan}'`);
  await ensure();
  const s: CheckoutSession = {
    id: randomBytes(32).toString("base64url"),
    user,
    plan,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };
  if (usingPostgres) {
    await pg().query("insert into checkout_sessions (id, user_id, plan, status, created_at, expires_at) values ($1,$2,$3,$4,$5,$6)", [
      s.id,
      s.user,
      s.plan,
      s.status,
      s.createdAt,
      s.expiresAt,
    ]);
  } else {
    lite()
      .prepare("insert into checkout_sessions (id, user_id, plan, status, created_at, expires_at) values (?,?,?,?,?,?)")
      .run(s.id, s.user, s.plan, s.status, s.createdAt, s.expiresAt);
  }
  return s;
}

/** Look up a session by id. Returns null for unknown ids AND expired ones, so the caller can't
 *  accidentally treat a stale session as live. */
export async function getCheckout(id: string): Promise<CheckoutSession | null> {
  if (!id || id.length < 20) return null; // never query on a value too short to be one of ours
  await ensure();
  const row = usingPostgres
    ? ((await pg().query("select * from checkout_sessions where id = $1", [id])).rows[0] as Record<string, unknown>)
    : (lite().prepare("select * from checkout_sessions where id = ?").get(id) as Record<string, unknown>);
  if (!row) return null;
  const s: CheckoutSession = {
    id: String(row.id),
    user: String(row.user_id),
    plan: String(row.plan) as PlanName,
    status: String(row.status) as CheckoutSession["status"],
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
  if (s.status === "pending" && Date.now() > s.expiresAt) return { ...s, status: "expired" };
  return s;
}

/** Retarget a pending session to a different paid plan. The website's plan picker calls this via
 *  the purchase route — the session id authorizes the change, and only while still pending, so a
 *  paid or expired session can never be redirected. */
export async function setCheckoutPlan(id: string, plan: PlanName): Promise<boolean> {
  if (!(plan in PLANS) || plan === "free") return false;
  await ensure();
  return usingPostgres
    ? (((await pg().query("update checkout_sessions set plan = $1 where id = $2 and status = 'pending'", [plan, id])).rowCount ?? 0) > 0)
    : lite().prepare("update checkout_sessions set plan = ? where id = ? and status = 'pending'").run(plan, id).changes > 0;
}

/** Mark a session paid and grant the plan. This is what a verified payment webhook calls.
 *
 *  Idempotent and single-use: the UPDATE only matches a row still `pending`, so a provider replaying
 *  the same event (they do, and out of order) can't grant the plan twice or resurrect an expired
 *  session. Returns false when nothing was claimed, which is a successful no-op, not an error. */
export async function completeCheckout(id: string): Promise<boolean> {
  const s = await getCheckout(id);
  if (!s || s.status !== "pending") return false;
  const claimed = usingPostgres
    ? ((await pg().query("update checkout_sessions set status = 'paid' where id = $1 and status = 'pending'", [id])).rowCount ?? 0) > 0
    : lite().prepare("update checkout_sessions set status = 'paid' where id = ? and status = 'pending'").run(id).changes > 0;
  if (!claimed) return false; // another delivery of the same event won the race
  await setPlan(s.user, s.plan, "active");
  return true;
}

/** Where to send the user to pay. Configurable because the site and the API are different origins
 *  in production and the same machine in development. */
export function checkoutUrl(id: string): string {
  const base = (process.env.ADA_SITE_URL ?? "https://adacodelabs.com").replace(/\/$/, "");
  return `${base}/upgrade?s=${encodeURIComponent(id)}`;
}
