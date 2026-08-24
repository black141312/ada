// Plans and quotas.
//
// This replaces the allow-list as the gate on chat. An allow-list answers "may this person in?",
// which is the wrong question for a product anyone can sign up for — the question is "what is this
// person entitled to?". Everyone authenticated gets in; the plan decides what they get.
//
// Quotas are counted in DOLLARS over a rolling 4-hour window, not tokens per month.
//
// Tokens were the honest unit while there was no price table — but a token cap prices a $25/1M
// model the same as a $0.10/1M one, so the only tier that could be offered safely was one that
// assumed the worst. Now that usage is costed from models.dev prices (usage.ts), the cap can be the
// thing the operator actually cares about: spend.
//
// 4 hours, not a month, because a monthly cap lets one bad afternoon burn the whole allowance and
// leaves the account dead for three weeks. A short window fails small and recovers on its own.
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./db.js";
import { adminUsers } from "./identity.js";
import { costSince, priceUsd } from "./usage.js";

export type PlanName = "free" | "pro" | "team";
export type PlanStatus = "active" | "past_due" | "canceled" | "banned";

export interface PlanDef {
  /** `free` restricts to the cheap free-tier models (see isFreeModel). `all` is the full catalogue. */
  models: "free" | "all";
  /** Upstream spend allowed per WINDOW_MS. NULL MEANS UNCAPPED — enterprise is billed by contract,
   *  so metering it is reporting, not gating. */
  capUsd: number | null;
  label: string;
}

/** The rolling spend window. */
export const WINDOW_MS = 4 * 60 * 60 * 1000;

/** Start of the current window. Fixed UTC buckets rather than a true rolling sum, so there is a real
 *  reset time to show a user ("resets at 16:00") instead of "some of it ages off gradually".
 *  ponytail: a burst can span a bucket edge and spend 2× the cap in a few minutes; move to a true
 *  rolling sum (sum over now-WINDOW_MS) if that ever shows up in the numbers. */
export const windowStart = (now = Date.now()): number => Math.floor(now / WINDOW_MS) * WINDOW_MS;

// Definitions live in code, not a table: they change rarely, and in git a limit change is reviewable
// and has an author. A `plans` table would make quotas editable with no diff and no history.
export const PLANS: Record<PlanName, PlanDef> = {
  free: { models: "free", capUsd: 0.5, label: "Free" },
  pro: { models: "all", capUsd: 2, label: "Pro" },
  team: { models: "all", capUsd: null, label: "Team" },
};

export interface UserPlan {
  user: string;
  plan: PlanName;
  status: PlanStatus;
  /** Period anchor in ms. Null means "calendar month", which is what an unpaid account gets. */
  periodStart: number | null;
  /** Access is good until this ms timestamp. NULL MEANS NEVER EXPIRES — a plan granted by hand
   *  should not die because nobody wrote a date. Only a payment provider sets a real one. */
  paidThrough: number | null;
  /** Per-user spend cap per window, in USD. Null = use the plan's cap. Set by an admin to raise (or
   *  shrink) one account's allowance without inventing a plan for it. */
  maxUsd: number | null;
}

const pg = () => authDatabase() as Pool;
const lite = () => authDatabase() as Database.Database;

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
      paid_through bigint,
      max_tokens bigint,
      updated_at bigint not null
    )`;
    if (usingPostgres) {
      await pg().query(ddl);
      // `create table if not exists` does nothing to a table that already exists, so an installation
      // that predates these columns would silently never get them.
      await pg().query("alter table user_plans add column if not exists paid_through bigint");
      await pg().query("alter table user_plans add column if not exists max_tokens bigint");
      await pg().query("alter table user_plans add column if not exists max_usd double precision");
    } else {
      lite().exec(ddl.replace(/bigint/g, "integer"));
      // SQLite has no `add column if not exists`; adding a column twice is an error, so ask first.
      const cols = lite().prepare("pragma table_info(user_plans)").all() as Array<{ name: string }>;
      for (const [col, type] of [["paid_through", "integer"], ["max_tokens", "integer"], ["max_usd", "real"]] as const) {
        if (!cols.some((c) => c.name === col)) lite().exec(`alter table user_plans add column ${col} ${type}`);
      }
    }
  })();
  return ready;
}

const TTL = 30_000;
const cache = new Map<string, { plan: UserPlan; exp: number }>();
export function invalidatePlanCache(user?: string): void {
  if (user) cache.delete(user);
  else cache.clear();
}

const DEFAULT_PLAN = (user: string): UserPlan => ({ user, plan: "free", status: "active", periodStart: null, paidThrough: null, maxUsd: null });

/** The plan for an account. No row means free — signing up is enough to be a free user, so a
 *  missing row is a normal state, not an error. A DB failure also yields free rather than throwing:
 *  the free tier only permits `:free` models, so failing that way costs nothing upstream. */
export async function planFor(user: string): Promise<UserPlan> {
  const hit = cache.get(user);
  if (hit && hit.exp > Date.now()) return hit.plan;
  let row: { plan?: string; status?: string; period_start?: number | string | null; paid_through?: number | string | null; max_usd?: number | string | null } | undefined;
  try {
    await ensure();
    row = usingPostgres
      ? ((await pg().query("select plan, status, period_start, paid_through, max_usd from user_plans where user_id = $1", [user])).rows[0] as typeof row)
      : (lite().prepare("select plan, status, period_start, paid_through, max_usd from user_plans where user_id = ?").get(user) as typeof row);
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
    paidThrough: row?.paid_through != null ? Number(row.paid_through) : null,
    maxUsd: row?.max_usd != null ? Number(row.max_usd) : null,
  };
  cache.set(user, { plan, exp: Date.now() + TTL });
  return plan;
}

/** Entitlements after status is applied. A lapsed subscription drops to free rather than locking
 *  the account out — a card that expires shouldn't read as a ban. */
export function effectivePlan(p: UserPlan, now = Date.now()): PlanDef & { name: PlanName } {
  // Access lapses on its own once the paid period ends. Without this the ONLY thing that ever
  // revokes a plan is a `subscription.cancelled` webhook arriving and being processed — so a missed
  // event, an exhausted retry or a card that quietly expires leaves a paid tier granted forever.
  // Fail closed on time, not open on silence.
  const lapsed = p.paidThrough != null && p.paidThrough <= now;
  // null = never expires: a plan granted by hand must not die because nobody wrote a date.
  const name: PlanName = p.status === "active" && !lapsed ? p.plan : "free";
  return { ...PLANS[name], name };
}

/** Start of the current billing period. Paid plans anchor to their subscription date so the window
 *  matches what was charged; everyone else gets the UTC calendar month. */
export function periodStart(p: UserPlan, now = Date.now()): number {
  const calendarMonth = () => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  // A period that has not started yet measures usage over an empty window: `used` reads 0, and
  // `used >= limit` is never true, so the QUOTA SILENTLY STOPS APPLYING. A bad anchor must cost a
  // reporting inaccuracy, never metering itself. Seen in production — a hand-entered row held
  // 12321313123123, which is the year 2360, and that account had been unmetered ever since.
  if (p.periodStart == null || !Number.isFinite(p.periodStart) || p.periodStart > now) return calendarMonth();
  // Roll the anchor forward in whole months until it's the period containing `now`.
  const anchor = new Date(p.periodStart);
  const d = new Date(now);
  let months = (d.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (d.getUTCMonth() - anchor.getUTCMonth());
  if (d.getUTCDate() < anchor.getUTCDate()) months--;
  if (months < 0) months = 0;
  const start = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, anchor.getUTCDate(), anchor.getUTCHours(), anchor.getUTCMinutes());
  // Belt and braces: month-end anchors (the 31st) can roll into a shorter month and overshoot.
  return start > now ? calendarMonth() : start;
}

export interface Entitlement {
  ok: boolean;
  /** Set when ok is false — the HTTP status the caller should return. */
  status?: 402 | 403;
  message?: string;
  plan: PlanName;
  /** Upstream spend so far this window, USD. */
  usedUsd: number;
  /** The cap in force (plan cap, or the account's override). Null = uncapped. */
  capUsd: number | null;
  /** When this window rolls over, ms. */
  resetsAt: number;
}

/** Blended $/1M above which a model is NOT on the free tier. Tuned so a free session runs on the
 *  small-and-fast tier (flash/mini/nano/small class) and the caps below buy a useful amount of it:
 *  at $0.30 blended, $0.50 is ~1.6M tokens every 4 hours. ADA_FREE_MAX_PRICE overrides. */
const FREE_MAX_PRICE = 0.6;

/** May the free plan run this model?
 *
 *  `:free` OpenRouter variants no longer qualify at all. Their quota is shared across every
 *  OpenRouter user AND capped per-minute per ACCOUNT — measured: a handful of calls in a minute
 *  returns `Rate limit exceeded: free-models-per-min` for every free model at once, not just the
 *  one being called. We run one account, so one user on a free model locks out everybody else on
 *  it. Two of them (google/gemma-4-*:free) answered 429 on every probe across an afternoon.
 *
 *  So the tier is defined by PRICE: anything cheap enough to give away under the spend cap.
 *  Cheap-and-always-up beats free-and-rate-limited. A price RULE rather than a hand-written list
 *  of ids on purpose — a list goes stale the week a lab reprices and nobody notices, because
 *  nothing breaks. ADA_FREE_MODELS still force-includes specific ids for testing.
 *  Read per call so a restart isn't needed mid-test. */
export function isFreeModel(id: string): boolean {
  const extra = process.env.ADA_FREE_MODELS;
  if (extra) {
    const want = id.toLowerCase();
    if (extra.split(",").some((m) => m.trim().toLowerCase() === want)) return true;
  }
  const [inPrice, outPrice] = priceUsd(id);
  // Blended 3:1 input:output — roughly the shape of a chat turn, and it stops a model with cheap
  // input and $20 output from sneaking in on its input price alone.
  const blended = (inPrice * 3 + outPrice) / 4;
  const max = Number(process.env.ADA_FREE_MAX_PRICE) || FREE_MAX_PRICE;
  // priceUsd() returns the pessimistic UNKNOWN_PRICE for an id it can't find, which is far above
  // any threshold — so "we don't know what this costs" resolves to "not free". A zero-priced model
  // fails `> 0` for the same reason: free upstream is not a reason to hand it out (see above).
  return blended > 0 && blended <= max;
}

/** The whole gate: may this account run this model right now? */
export async function checkEntitlement(user: string, model: string): Promise<Entitlement> {
  const since = windowStart();
  const resetsAt = since + WINDOW_MS;
  const spend = () => costSince(user, since).then((c) => c.usd).catch(() => 0);
  // God mode: env-listed admins are never metered or model-gated. The list lives in env, not the
  // database, so it cannot be self-granted through any API. Usage is still recorded and reported —
  // unlimited spend should still be visible spend.
  if (adminUsers()?.includes(user)) {
    return { ok: true, plan: "team", usedUsd: await spend(), capUsd: null, resetsAt };
  }
  const up = await planFor(user);
  // Banned beats everything except god mode (above): no models, not even free ones. 403, not 402 —
  // there is nothing the user can pay to fix.
  if (up.status === "banned") {
    return { ok: false, status: 403, message: "This account is suspended.", plan: up.plan, usedUsd: 0, capUsd: 0, resetsAt };
  }
  const def = effectivePlan(up);
  const usedUsd = await spend();
  // A per-user override beats the plan's cap — how an admin grants one account more (or less)
  // without inventing a plan for it. Both can be null, which means uncapped.
  const capUsd = up.maxUsd ?? def.capUsd;
  const base = { plan: def.name, usedUsd, capUsd, resetsAt };

  if (def.models === "free" && !isFreeModel(model)) {
    return {
      ...base,
      ok: false,
      status: 403,
      message: `${def.label} plan covers the free model tier only. Upgrade to use ${model}.`,
    };
  }
  if (capUsd != null && usedUsd >= capUsd) {
    const at = new Date(resetsAt).toISOString().slice(11, 16);
    return {
      ...base,
      ok: false,
      status: 402,
      message: `${def.label} plan cap reached — $${usedUsd.toFixed(2)} of $${capUsd.toFixed(2)} per ${WINDOW_MS / 3_600_000} hours. Resets at ${at} UTC.`,
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
export async function setPlan(
  user: string,
  plan: PlanName,
  status: PlanStatus = "active",
  anchorNow = true,
  paidThrough: number | null = null,
  /** undefined = leave any existing override alone (so payment webhooks can't wipe an admin-set
   *  cap); null = clear the override; a number = set it. USD per window. */
  maxUsd: number | null | undefined = undefined,
): Promise<void> {
  await ensure();
  const now = Date.now();
  const start = anchorNow && plan !== "free" ? now : null;
  const setMax = maxUsd === undefined ? "" : "max_usd = excluded.max_usd, ";
  if (usingPostgres) {
    await pg().query(
      `insert into user_plans (user_id, plan, status, period_start, paid_through, max_usd, updated_at) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, period_start = excluded.period_start, paid_through = excluded.paid_through, ${setMax}updated_at = excluded.updated_at`,
      [user, plan, status, start, paidThrough, maxUsd ?? null, now],
    );
  } else {
    lite()
      .prepare(
        `insert into user_plans (user_id, plan, status, period_start, paid_through, max_usd, updated_at) values (?,?,?,?,?,?,?)
         on conflict (user_id) do update set plan = excluded.plan, status = excluded.status, period_start = excluded.period_start, paid_through = excluded.paid_through, ${setMax}updated_at = excluded.updated_at`,
      )
      .run(user, plan, status, start, paidThrough, maxUsd ?? null, now);
  }
  invalidatePlanCache(user);
}
