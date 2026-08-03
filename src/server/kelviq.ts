// Kelviq (kelviq.com) — the payment provider behind the checkout-session seam. Kelviq is a merchant
// of record: it owns the hosted payment page, subscriptions, tax, and invoicing. This module keeps
// our side of the contract small: read the plan catalog (so the website's pricing comes from the
// Kelviq dashboard, not hardcoded HTML), mint hosted-checkout sessions, and verify + apply the
// signed webhooks that make a payment grant a plan. Zero dependencies — plain fetch + node:crypto.
// With KELVIQ_API_KEY unset, everything is off and the server behaves exactly as before.
import { createHmac, timingSafeEqual } from "node:crypto";
import { completeCheckout } from "./billing.js";
import { setPlan, type PlanName } from "./plans.js";

const API_KEY = process.env.KELVIQ_API_KEY || "";
const PROD = process.env.KELVIQ_ENV === "production";
const BASE = (process.env.KELVIQ_API_URL || (PROD ? "https://api.kelviq.com/api/v1" : "https://sandboxapi.kelviq.com/api/v1")).replace(/\/+$/, "");
const PRODUCT_ID = process.env.KELVIQ_PRODUCT_ID || "";
const WEBHOOK_SECRET = process.env.KELVIQ_WEBHOOK_SECRET || "";

/** Kelviq is "on" once a server key + product are configured; the webhook additionally needs its secret. */
export function kelviqEnabled(): boolean {
  return !!(API_KEY && PRODUCT_ID);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`kelviq ${init?.method ?? "GET"} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}

// Kelviq plan identifier → our plan tier. Explicit map first (KELVIQ_PLAN_MAP='{"scale":"team"}'),
// name heuristics as fallback so conventional names Just Work.
const PLAN_MAP: Record<string, PlanName> = (() => {
  try {
    return JSON.parse(process.env.KELVIQ_PLAN_MAP || "{}") as Record<string, PlanName>;
  } catch {
    console.error("kelviq: KELVIQ_PLAN_MAP is not valid JSON — ignoring");
    return {};
  }
})();

function mapPlan(identifier: string): PlanName {
  const m = PLAN_MAP[identifier];
  if (m === "free" || m === "pro" || m === "team") return m;
  if (/team|enterprise|scale|org/i.test(identifier)) return "team";
  if (/pro|growth|paid|plus/i.test(identifier)) return "pro";
  return "free";
}

export interface KelviqPlan {
  identifier: string; // Kelviq's plan id — what checkout wants
  plan: PlanName; // our tier — what quotas key off
  name: string;
  prices: Record<string, number>; // chargePeriod → amount (e.g. { MONTHLY: 20 })
}

export interface KelviqCatalog {
  currency: string;
  symbol: string;
  plans: KelviqPlan[];
}

// The catalog is dashboard-managed and changes rarely; a short cache keeps it off the hot path
// while edits in Kelviq still show up within a minute.
let catalogCache: { at: number; value: KelviqCatalog } | null = null;

export async function getKelviqCatalog(): Promise<KelviqCatalog> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.value;
  const r = await api(`/monetization/product-offering/${PRODUCT_ID}/`);
  const o = (await r.json()) as {
    currencyCode?: string;
    currencySymbol?: string;
    plans?: Array<{
      identifier?: string;
      name?: string;
      displayName?: string;
      price?: { charges?: Array<{ chargePeriod?: string; priceData?: { amount?: number } }> };
    }>;
  };
  const plans: KelviqPlan[] = (o.plans ?? [])
    .filter((p) => p.identifier)
    .map((p) => {
      const prices: Record<string, number> = {};
      for (const c of p.price?.charges ?? []) {
        if (c.chargePeriod && typeof c.priceData?.amount === "number") prices[c.chargePeriod] = c.priceData.amount;
      }
      return { identifier: p.identifier!, plan: mapPlan(p.identifier!), name: p.displayName || p.name || p.identifier!, prices };
    });
  catalogCache = { at: Date.now(), value: { currency: o.currencyCode ?? "USD", symbol: o.currencySymbol ?? "$", plans } };
  return catalogCache.value;
}

/** Create a Kelviq hosted-checkout session for one of our checkout sessions. The metadata carries
 *  the session id, so the payment webhook can complete exactly the session that started the flow —
 *  the customer id is our user id, never a credential. */
export async function createKelviqCheckout(opts: {
  kelviqPlan: string;
  user: string;
  sessionId: string;
  successUrl: string;
  cancelUrl?: string;
  chargePeriod?: string;
}): Promise<{ checkoutUrl: string; checkoutSessionId: string }> {
  const r = await api("/checkout/", {
    method: "POST",
    body: JSON.stringify({
      planIdentifier: opts.kelviqPlan,
      customerId: opts.user,
      successUrl: opts.successUrl,
      chargePeriod: opts.chargePeriod ?? "MONTHLY",
      ...(opts.cancelUrl ? { cancelUrl: opts.cancelUrl } : {}),
      metadata: { adaCheckout: opts.sessionId },
    }),
  });
  return (await r.json()) as { checkoutUrl: string; checkoutSessionId: string };
}

/** Verify Kelviq's webhook signature: HMAC-SHA256 over `{id}.{timestamp}.{rawBody}` with the signing
 *  secret; the header carries `v1,{digest}` entries. Stale timestamps (>5 min) are rejected. */
export function verifyKelviqSignature(h: { id?: string; timestamp?: string; signature?: string }, rawBody: string): boolean {
  if (!WEBHOOK_SECRET || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const mac = createHmac("sha256", WEBHOOK_SECRET).update(`${h.id}.${h.timestamp}.${rawBody}`).digest();
  const candidates = [mac.toString("hex"), mac.toString("base64")];
  for (const part of h.signature.split(/\s+/)) {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    for (const want of candidates) {
      const a = Buffer.from(sig);
      const b = Buffer.from(want);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

export interface KelviqEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

/** When the paid period ends, from whatever the provider called it. Kelviq's payload shape is not
 *  pinned down here, so several spellings are tried and anything unrecognised yields null — and null
 *  means "never expires", i.e. exactly today's behaviour. A wrong guess must not cut someone off. */
export function paidThroughOf(obj: Record<string, unknown>): number | null {
  for (const k of ["currentPeriodEnd", "current_period_end", "periodEnd", "period_end", "expiresAt", "expires_at", "endsAt", "ends_at"]) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000; // seconds or ms
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** Apply a verified webhook event. Payment events carry our session id in metadata and complete it
 *  (idempotent — replays are no-ops); lifecycle events without one fall back to the customer id,
 *  which IS our user id. Returns a short description for the audit log, or null if irrelevant. */
export async function handleKelviqWebhook(evt: KelviqEvent): Promise<string | null> {
  const type = evt.type ?? "";
  const obj = evt.data?.object ?? {};
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  const sessionId = typeof meta.adaCheckout === "string" ? meta.adaCheckout : "";
  const customer = typeof obj.customerId === "string" ? obj.customerId : typeof obj.customer_id === "string" ? (obj.customer_id as string) : "";

  if (/^(checkout\.completed|subscription\.created)$/.test(type) && sessionId) {
    const done = await completeCheckout(sessionId);
    return `${type} → session ${sessionId.slice(0, 8)}… ${done ? "completed" : "already settled"}`;
  }
  if (/^subscription\.(updated|plan_changed)$/.test(type) && customer) {
    const ident = obj.planIdentifier ?? (obj.plan as Record<string, unknown> | undefined)?.identifier;
    if (typeof ident === "string" && ident) {
      const until = paidThroughOf(obj);
      await setPlan(customer, mapPlan(ident), "active", true, until);
      return `${type} → ${customer} set to ${mapPlan(ident)}${until ? ` until ${new Date(until).toISOString().slice(0, 10)}` : ""}`;
    }
  }
  if (type === "subscription.cancelled" && customer) {
    // Cancelling is not a refund: someone who cancels on day 2 keeps what they bought until the
    // period they paid for runs out. With no end date in the payload this stays an immediate
    // downgrade, which is the old behaviour.
    const until = paidThroughOf(obj);
    if (until && until > Date.now()) {
      const ident = obj.planIdentifier ?? (obj.plan as Record<string, unknown> | undefined)?.identifier;
      const keep = typeof ident === "string" && ident ? mapPlan(ident) : "pro";
      await setPlan(customer, keep, "active", false, until);
      return `${type} → ${customer} keeps ${keep} until ${new Date(until).toISOString().slice(0, 10)}`;
    }
    await setPlan(customer, "free", "active");
    return `${type} → ${customer} downgraded to free`;
  }
  return null;
}
