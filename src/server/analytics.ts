// The operator's mirror: where is ada being used, and where is money leaking. Everything here is
// derived at read time from tables the server already writes — usage_events (every request's
// tokens), user_plans (who pays), checkout_sessions (who tried to) — plus Kelviq for subscription
// truth when configured. No new writes, no new storage: analytics that can drift from the billing
// numbers is worse than none.
//
// The `insights` list is the point of the exercise. Charts answer "what happened"; insights answer
// "what should the operator do" — each one is a computed claim (low conversion, an upsell pool,
// usage concentration) that names an improvement area. They are pure functions of the aggregates,
// so they are testable without a database.
import type { Pool } from "pg";
import type Database from "better-sqlite3";
import { authDatabase, usingPostgres } from "./db.js";
import { PLANS, type PlanName } from "./plans.js";
import { kelviqEnabled, listKelviqSubscriptions } from "./kelviq.js";

const DAY_MS = 86_400_000;

const pg = () => authDatabase() as Pool;
const lite = () => authDatabase() as Database.Database;

/** Run one SELECT against whichever database is configured. `?` placeholders; translated for pg. */
async function all<T>(sql: string, params: unknown[]): Promise<T[]> {
  if (usingPostgres) {
    let i = 0;
    const translated = sql.replace(/\?/g, () => `$${++i}`);
    return (await pg().query(translated, params)).rows as T[];
  }
  return lite().prepare(sql).all(...(params as never[])) as T[];
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  requests: number;
  tokens: number;
  activeUsers: number;
}

/** When Ada is used, in each user's OWN local time, and how fast it answered. */
export interface Timing {
  /** 24 buckets, always all present so the chart has a fixed x-axis. */
  hourly: { hour: number; requests: number }[];
  /** 7 buckets, 0 = Sunday. */
  weekday: { day: number; requests: number }[];
  /** Exact percentiles over the rows that carry a measurement. `measured` says how many that was —
   *  without it a p95 computed from three requests reads like a fact. */
  latency: { p50: number | null; p95: number | null; ttftP50: number | null; ttftP95: number | null; measured: number };
  /** Share of requests whose client sent no timezone; hourly/weekday cannot see these. */
  unknownTzPct: number;
}

/** Roughly where usage comes from. Timezone is client-reported; country only exists when a proxy
 *  in front of the server resolved one. Neither is derived from an address we store. */
export interface Locations {
  timezones: { tz: string; requests: number; tokens: number; users: number }[];
  countries: { country: string; requests: number; users: number }[];
}

export interface Insight {
  level: "good" | "info" | "warn";
  text: string;
}

export interface Analytics {
  windowDays: number;
  generatedAt: number;
  totals: { requests: number; tokens: number; activeUsers: number };
  daily: DailyPoint[];
  models: { model: string; requests: number; tokens: number }[];
  topUsers: { user: string; requests: number; tokens: number; plan: PlanName; pctOfQuota: number }[];
  plans: { plan: string; users: number }[];
  funnel: { minted: number; paid: number; expired: number; pending: number; conversionPct: number | null };
  timing: Timing;
  locations: Locations;
  revenue: { activeSubs: number; mrr: number; currency: string } | null;
  insights: Insight[];
}

/**
 * Minutes to add to UTC to get local time in `tz`, using the CURRENT offset.
 *
 * A window can straddle a DST change, so a bucket from before one lands an hour off. That is
 * accepted: this feeds an hour-of-day histogram meant to answer "mornings or evenings", and paying
 * for per-instant offset resolution would not change that answer. Unknown zones — a client sending
 * something Intl does not recognise — contribute 0 rather than throwing the dashboard.
 */
const tzOffsetCache = new Map<string, number>();
export function offsetMinutes(tz: string): number {
  const hit = tzOffsetCache.get(tz);
  if (hit !== undefined) return hit;
  let mins = 0;
  try {
    // Format one instant in both UTC and the target zone and diff them. `en-CA` gives an
    // ISO-ordered date, so Date.parse reads both back unambiguously.
    const at = new Date();
    const fmt = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
    const asUtc = Date.parse(fmt("UTC").replace(", ", "T") + "Z");
    const asLocal = Date.parse(fmt(tz).replace(", ", "T") + "Z");
    if (Number.isFinite(asUtc) && Number.isFinite(asLocal)) mins = Math.round((asLocal - asUtc) / 60_000);
  } catch {
    mins = 0; // unrecognised zone — treat as UTC rather than dropping the requests
  }
  tzOffsetCache.set(tz, mins);
  return mins;
}

/**
 * Exact percentile of one column, by ordering and offsetting.
 *
 * Neither `percentile_cont` (Postgres) nor a window function is available on both engines, and an
 * average would be the wrong statistic anyway — latency is long-tailed, so the mean sits under most
 * of the pain. Two cheap queries beat a number nobody should act on. Returns null when nothing has
 * been measured yet, which the dashboard renders as "—" rather than 0ms.
 */
async function percentile(column: "ms" | "ttft_ms", q: number, since: number): Promise<number | null> {
  const n = Number(((await all<{ c: number }>(`select count(*) as c from usage_events where ts >= ? and ${column} is not null`, [since]))[0] ?? { c: 0 }).c);
  if (n === 0) return null;
  const offset = Math.min(n - 1, Math.floor(n * q));
  const row = (await all<{ v: number }>(`select ${column} as v from usage_events where ts >= ? and ${column} is not null order by ${column} limit 1 offset ${offset}`, [since]))[0];
  return row ? Number(row.v) : null;
}

export async function computeAnalytics(windowDays = 30): Promise<Analytics> {
  const since = Date.now() - windowDays * DAY_MS;

  const totalsRow = (
    await all<{ c: number; t: number; u: number }>(
      "select count(*) as c, coalesce(sum(prompt_tokens + completion_tokens), 0) as t, count(distinct user_id) as u from usage_events where ts >= ?",
      [since],
    )
  )[0] ?? { c: 0, t: 0, u: 0 };

  const dailyRows = await all<{ d: number; c: number; t: number; u: number }>(
    "select ts / 86400000 as d, count(*) as c, sum(prompt_tokens + completion_tokens) as t, count(distinct user_id) as u from usage_events where ts >= ? group by d order by d",
    [since],
  );
  // Fill missing days with zeros — a gap in the chart should look like a gap, not a shorter chart.
  const byDay = new Map(dailyRows.map((r) => [Number(r.d), r]));
  const daily: DailyPoint[] = [];
  for (let d = Math.floor(since / DAY_MS); d <= Math.floor(Date.now() / DAY_MS); d++) {
    const r = byDay.get(d);
    daily.push({
      date: new Date(d * DAY_MS).toISOString().slice(0, 10),
      requests: Number(r?.c ?? 0),
      tokens: Number(r?.t ?? 0),
      activeUsers: Number(r?.u ?? 0),
    });
  }

  const models = (
    await all<{ model: string; c: number; t: number }>(
      "select model, count(*) as c, sum(prompt_tokens + completion_tokens) as t from usage_events where ts >= ? group by model order by t desc limit 12",
      [since],
    )
  ).map((r) => ({ model: r.model, requests: Number(r.c), tokens: Number(r.t) }));

  const planRows = await all<{ user_id: string; plan: string; status: string }>("select user_id, plan, status from user_plans", []);
  // A plan string outside PLANS (a Kelviq identifier, a retired tier) made PLANS[plan] undefined and
  // took the whole dashboard down at pctOfQuota. Unknown ⇒ free, same as a lapsed one.
  const planOf = new Map(planRows.map((r) => [r.user_id, (r.status === "active" && r.plan in PLANS ? r.plan : "free") as PlanName]));
  const planCounts = new Map<string, number>();
  for (const p of planOf.values()) planCounts.set(p, (planCounts.get(p) ?? 0) + 1);
  const plans = [...planCounts.entries()].map(([plan, users]) => ({ plan, users })).sort((a, b) => b.users - a.users);

  const topUsers = (
    await all<{ user_id: string; c: number; t: number }>(
      "select user_id, count(*) as c, sum(prompt_tokens + completion_tokens) as t from usage_events where ts >= ? group by user_id order by t desc limit 10",
      [since],
    )
  ).map((r) => {
    const plan = planOf.get(r.user_id) ?? "free";
    return {
      user: r.user_id,
      requests: Number(r.c),
      tokens: Number(r.t),
      plan,
      pctOfQuota: Math.round((Number(r.t) / PLANS[plan].monthlyTokens) * 100),
    };
  });

  const funnelRows = await all<{ status: string; c: number }>(
    "select status, count(*) as c from checkout_sessions where created_at >= ? group by status",
    [since],
  );
  const stalePending = (
    await all<{ c: number }>("select count(*) as c from checkout_sessions where created_at >= ? and status = 'pending' and expires_at < ?", [
      since,
      Date.now(),
    ])
  )[0] ?? { c: 0 };
  const by = new Map(funnelRows.map((r) => [r.status, Number(r.c)]));
  const paid = by.get("paid") ?? 0;
  const expired = (by.get("expired") ?? 0) + Number(stalePending.c); // stale pendings ARE expired, the row just hasn't been read since
  const pending = Math.max(0, (by.get("pending") ?? 0) - Number(stalePending.c));
  const minted = paid + expired + pending;
  const funnel = { minted, paid, expired, pending, conversionPct: minted > 0 ? Math.round((paid / minted) * 100) : null };

  let revenue: Analytics["revenue"] = null;
  if (kelviqEnabled()) {
    try {
      const subs = await listKelviqSubscriptions();
      const active = subs.filter((s) => s.status === "active");
      // Normalize to monthly: a yearly charge contributes a twelfth. Good enough for a dashboard.
      const mrr = active.reduce((n, s) => n + (s.recurrence.includes("year") ? s.amount / 12 : s.amount), 0);
      revenue = { activeSubs: active.length, mrr: Math.round(mrr * 100) / 100, currency: active[0]?.currency ?? "USD" };
    } catch {
      revenue = null; // Kelviq being down must not take the dashboard down
    }
  }


  // --- timing & location ----------------------------------------------------
  // Local-time bucketing without a portable IANA function: sqlite has none, and doing it in
  // Postgres only would make the dashboard disagree with itself between deployments. Instead group
  // by (tz, absolute UTC bucket) and shift each bucket by that zone's offset here, where Intl exists.
  //
  // The bucket is a QUARTER hour, not an hour. Offsets are not all whole hours — India is +5:30,
  // Nepal +5:45 — so flooring to hours first and shifting after put 09:00 IST (03:30 UTC) into the
  // 08:00 bucket. Every real IANA offset is a multiple of 15 minutes, so at this granularity the
  // shift is exact for every zone. Cost is 4x the rows: bounded by distinct (zone, quarter-hour)
  // pairs that actually saw traffic, which for an admin dashboard is comfortably small.
  const tzHourRows = await all<{ tz: string | null; h: number; c: number; t: number }>(
    "select tz, ts / 900000 as h, count(*) as c, sum(prompt_tokens + completion_tokens) as t from usage_events where ts >= ? group by tz, h",
    [since],
  );
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0 }));
  const weekday = Array.from({ length: 7 }, (_, day) => ({ day, requests: 0 }));
  let placed = 0;
  for (const r of tzHourRows) {
    if (!r.tz) continue; // no timezone reported — counted in totals, invisible to these two charts
    const localMs = Number(r.h) * 900_000 + offsetMinutes(r.tz) * 60_000;
    const d = new Date(localMs);
    hourly[d.getUTCHours()]!.requests += Number(r.c); // getUTC* on an already-shifted instant = local
    weekday[d.getUTCDay()]!.requests += Number(r.c);
    placed += Number(r.c);
  }
  const totalReq = Number(totalsRow.c);
  const unknownTzPct = totalReq > 0 ? Math.round(((totalReq - placed) / totalReq) * 100) : 0;

  const timing: Timing = {
    hourly,
    weekday,
    latency: {
      p50: await percentile("ms", 0.5, since),
      p95: await percentile("ms", 0.95, since),
      ttftP50: await percentile("ttft_ms", 0.5, since),
      ttftP95: await percentile("ttft_ms", 0.95, since),
      measured: Number(((await all<{ c: number }>("select count(*) as c from usage_events where ts >= ? and ms is not null", [since]))[0] ?? { c: 0 }).c),
    },
    unknownTzPct,
  };

  const locations: Locations = {
    timezones: (
      await all<{ tz: string; c: number; t: number; u: number }>(
        "select tz, count(*) as c, sum(prompt_tokens + completion_tokens) as t, count(distinct user_id) as u from usage_events where ts >= ? and tz is not null group by tz order by c desc limit 12",
        [since],
      )
    ).map((r) => ({ tz: r.tz, requests: Number(r.c), tokens: Number(r.t), users: Number(r.u) })),
    countries: (
      await all<{ country: string; c: number; u: number }>(
        "select country, count(*) as c, count(distinct user_id) as u from usage_events where ts >= ? and country is not null group by country order by c desc limit 12",
        [since],
      )
    ).map((r) => ({ country: r.country, requests: Number(r.c), users: Number(r.u) })),
  };

  const totals = { requests: Number(totalsRow.c), tokens: Number(totalsRow.t), activeUsers: Number(totalsRow.u) };
  return {
    windowDays,
    generatedAt: Date.now(),
    totals,
    daily,
    models,
    topUsers,
    plans,
    timing,
    locations,
    funnel,
    revenue,
    insights: computeInsights({ totals, models, topUsers, funnel, revenue }),
  };
}

/** The improvement-areas engine. Pure so it can be exercised in selfcheck without a database. */
export function computeInsights(a: {
  totals: Analytics["totals"];
  models: Analytics["models"];
  topUsers: Analytics["topUsers"];
  funnel: Analytics["funnel"];
  revenue: Analytics["revenue"];
}): Insight[] {
  const out: Insight[] = [];
  const { totals, models, topUsers, funnel, revenue } = a;

  if (totals.requests === 0) {
    out.push({ level: "info", text: "No usage recorded in this window — nothing to optimise yet." });
    return out;
  }

  if (funnel.minted >= 3 && funnel.conversionPct !== null && funnel.conversionPct < 40) {
    out.push({
      level: "warn",
      text: `Checkout converts at ${funnel.conversionPct}% (${funnel.expired} of ${funnel.minted} started upgrades never paid) — shorten the path to payment or follow up on abandoned checkouts.`,
    });
  } else if (funnel.paid > 0 && funnel.conversionPct !== null && funnel.conversionPct >= 40) {
    out.push({ level: "good", text: `Checkout converts at ${funnel.conversionPct}% (${funnel.paid}/${funnel.minted}).` });
  }

  const upsell = topUsers.filter((u) => u.plan === "free" && u.pctOfQuota >= 80);
  if (upsell.length > 0) {
    out.push({
      level: "info",
      text: `${upsell.length} free ${upsell.length === 1 ? "user is" : "users are"} at ≥80% of quota — the natural moment to surface the upgrade page.`,
    });
  }

  if (topUsers.length > 1 && totals.tokens > 0 && topUsers[0]!.tokens / totals.tokens > 0.5) {
    out.push({
      level: "warn",
      text: `${Math.round((topUsers[0]!.tokens / totals.tokens) * 100)}% of all usage comes from one account (${topUsers[0]!.user}) — growth depends on a single user.`,
    });
  }

  if (models.length > 1 && totals.tokens > 0 && models[0]!.tokens / totals.tokens > 0.8) {
    out.push({
      level: "info",
      text: `${Math.round((models[0]!.tokens / totals.tokens) * 100)}% of tokens run on ${models[0]!.model} — anchor pricing and capacity planning on it.`,
    });
  }

  const paidUsers = topUsers.filter((u) => u.plan !== "free");
  const idlePaid = paidUsers.filter((u) => u.pctOfQuota < 5);
  if (idlePaid.length > 0) {
    out.push({
      level: "warn",
      text: `${idlePaid.length} paying ${idlePaid.length === 1 ? "account uses" : "accounts use"} <5% of quota — churn risk; a check-in beats a surprise cancellation.`,
    });
  }

  if (revenue && revenue.activeSubs > 0) {
    out.push({ level: "good", text: `${revenue.activeSubs} active subscription${revenue.activeSubs === 1 ? "" : "s"} · ~${revenue.currency} ${revenue.mrr}/month recurring.` });
  }

  return out;
}
