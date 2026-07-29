// Plans and quotas.
//
// This replaces the allow-list as the gate on chat. An allow-list answers "may this person in?",
// which is the wrong question for a product anyone can sign up for — the question is "what is this
// person entitled to?". Everyone authenticated gets in; the plan decides what they get.
//
// Quotas are counted in TOKENS, not dollars. Dollars are what actually matters to the operator, but
// they need a live price table per model, they drift under the user mid-month, and "you have 40k
// tokens left" is a sentence a user can act on. Tokens are also what usage_events already stores,
// so the number enforced is the number recorded — no conversion to disagree about later.
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./auth.js";
import { usageSince } from "./usage.js";

export type PlanName = "free" | "pro" | "team";
export type PlanStatus = "active" | "past_due" | "canceled";

export interface PlanDef {
  /** `free` restricts to `:free` models, which cost nothing upstream. `all` is the full catalogue. */
  models: "free" | "all";
  /** Prompt + completion tokens per billing period. */
  monthlyTokens: number;
  label: string;
}

// Definitions live in code, not a table: they change rarely, and in git a limit change is reviewable
// and has an author. A `plans` table would make quotas editable with no diff and no history.
export const PLANS: Record<PlanName, PlanDef> = {
  free: { models: "free", monthlyTokens: 2_000_000, label: "Free" },
  pro: { models: "all", monthlyTokens: 25_000_000, label: "Pro" },
  team: { models: "all", monthlyTokens: 120_000_000, label: "Team" },
};

export interface UserPlan {
  user: string;
  plan: PlanName;
  status: PlanStatus;
  /** Period anchor in ms. Null means "calendar month", which is what an unpaid account gets. */
  periodStart: number | null;
}

const pg = () => authDatabase as Pool;
const lite = () => authDatabase as Database.Database;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  ready ??= (async () => {
    // Deliberately NOT a column on Better Auth's `user` table — that schema belongs to the library
    // and it migrates it. Our billing state lives in our own table, joined by id.
    const ddl = `create table if not exists user_plans (
      user_id text primary key,
      plan text not null default 'free',
      status text not null default 'active',
      period_start bigint,
      updated_at bigint not null
    )`;
    if (usingPostgres) await pg().query(ddl);
    else lite().exec(ddl.replace("bigint", "integer").replace("bigint", "integer"));
  })();
  return ready;
}

const TTL = 30_000;
const cache = new Map<string, { plan: UserPlan; exp: number }>();
export function invalidatePlanCache(user?: string): void {
  if (user) cache.delete(user);
  else cache.clear();
}

const DEFAULT_PLAN = (user: string): UserPlan => ({ user, plan: "free", status: "active", periodStart: null });

/** The plan for an account. No row means free — signing up is enough to be a free user, so a
 *  missing row is a normal state, not an error. A DB failure also yields free rather than throwing:
 *  the free tier only permits `:free` models, so failing that way costs nothing upstream. */
export async function planFor(user: string): Promise<UserPlan> {
  const hit = cache.get(user);
  if (hit && hit.exp > Date.now()) return hit.plan;
  let row: { plan?: string; status?: string; period_start?: number | string | null } | undefined;
  try {
    await ensure();
    row = usingPostgres
      ? ((await pg().query("select plan, status, period_start from user_plans where user_id = $1", [user])).rows[0] as typeof row)
      : (lite().prepare("select plan, status, period_start from user_plans where user_id = ?").get(user) as typeof row);
  } catch (e) {
    console.error("[ada] plan lookup failed:", e instanceof Error ? e.message : e);
    return DEFAULT_PLAN(user);
  }
  const name = (row?.plan ?? "free") as PlanName;
  const plan: UserPlan = {
    user,
    plan: PLANS[name] ? name : "free", // an unknown plan string must not grant the full catalogue
    status: (row?.status ?? "active") as PlanStatus,
    periodStart: row?.period_start != null ? Number(row.period_start) : null,
  };
  cache.set(user, { plan, exp: Date.now() + TTL });
  return plan;
}

/** Entitlements after status is applied. A lapsed subscription drops to free rather than locking
 *  the account out — a card that expires shouldn't read as a ban. */
export function effectivePlan(p: UserPlan): PlanDef & { name: PlanName } {
  const name: PlanName = p.status === "active" ? p.plan : "free";
  return { ...PLANS[name], name };
}

/** Start of the current billing period. Paid plans anchor to their subscription date so the window
 *  matches what was charged; everyone else gets the UTC calendar month. */
export function periodStart(p: UserPlan, now = Date.now()): number {
  if (p.periodStart == null) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  // Roll the anchor forward in whole months until it's the period containing `now`.
  const anchor = new Date(p.periodStart);
  const d = new Date(now);
  let months = (d.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (d.getUTCMonth() - anchor.getUTCMonth());
  if (d.getUTCDate() < anchor.getUTCDate()) months--;
  if (months < 0) months = 0; // an anchor in the future: treat the first period as current
  return Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, anchor.getUTCDate(), anchor.getUTCHours(), anchor.getUTCMinutes());
}

export interface Entitlement {
  ok: boolean;
  /** Set when ok is false — the HTTP status the caller should return. */
  status?: 402 | 403;
  message?: string;
  plan: PlanName;
  used: number;
  limit: number;
}

const isFreeModel = (id: string) => /:free$/i.test(id);

/** The whole gate: may this account run this model right now? */
export async function checkEntitlement(user: string, model: string): Promise<Entitlement> {
  const up = await planFor(user);
  const def = effectivePlan(up);
  const since = periodStart(up);
  const used = await usageSince(user, since).then((u) => u.promptTokens + u.completionTokens).catch(() => 0);
  const base = { plan: def.name, used, limit: def.monthlyTokens };

  if (def.models === "free" && !isFreeModel(model)) {
    return {
      ...base,
      ok: false,
      status: 403,
      message: `${def.label} plan covers \`:free\` models only. Upgrade to use ${model}.`,
    };
  }
  if (used >= def.monthlyTokens) {
    return {
      ...base,
      ok: false,
      status: 402,
      message: `${def.label} plan quota reached — ${used.toLocaleString()} of ${def.monthlyTokens.toLocaleString()} tokens this period. Resets ${new Date(since).toISOString().slice(0, 10)} + 1 month.`,
    };
  }
  return { ...base, ok: true };
}

/** The seam a payment provider plugs into.
 *
 *  Deliberately NOT implemented rather than stubbed as a working endpoint: a webhook route that
 *  accepts a body and calls setPlan() is an unauthenticated way for anyone to grant themselves a
 *  paid plan. The signature check is the whole security of a webhook, so the route stays closed
 *  until it exists.
 *
 *  When wiring Razorpay or Stripe, the order matters:
 *    1. verify the signature against the RAW body — parsing first and re-serialising will not match
 *    2. map the provider's customer/subscription id to a user (needs a column here, or a lookup
 *       table; the provider's id is the durable key, not the email)
 *    3. call setPlan(user, plan, status) — `active` on payment, `past_due` on failure,
 *       `canceled` on cancellation. effectivePlan() already degrades the last two to free.
 *    4. respond 2xx fast; providers retry on timeout and will replay the event
 *  Events arrive out of order and more than once, so step 3 must be idempotent — setPlan is. */
export function billingWebhookImplemented(): boolean {
  return false;
}

/** Set or change an account's plan. Called by the admin API today, by a payment webhook later. */
export async function setPlan(user: string, plan: PlanName, status: PlanStatus = "active", anchorNow = true): Promise<void> {
  await ensure();
  const now = Date.now();
  const start = anchorNow && plan !== "free" ? now : null;
  if (usingPostgres) {
    await pg().query(
      `insert into user_plans (user_id, plan, status, period_start, updated_at) values ($1,$2,$3,$4,$5)
       on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, period_start = excluded.period_start, updated_at = excluded.updated_at`,
      [user, plan, status, start, now],
    );
  } else {
    lite()
      .prepare(
        `insert into user_plans (user_id, plan, status, period_start, updated_at) values (?,?,?,?,?)
         on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, period_start = excluded.period_start, updated_at = excluded.updated_at`,
      )
      .run(user, plan, status, start, now);
  }
  invalidatePlanCache(user);
}
