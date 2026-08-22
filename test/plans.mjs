// Plan entitlements: who may run which model, and when they're out of quota.
// This replaces the allow-list as the gate on chat, so a wrong answer here either bills for work
// that shouldn't have run or blocks someone who paid.
//   run: node --import tsx test/plans.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-plans-"));
delete process.env.DATABASE_URL; // sqlite; postgres takes the same SQL shape
process.env.ADA_DATA_DIR = dir;
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const { PLANS, planFor, setPlan, effectivePlan, periodStart, windowStart, WINDOW_MS, isFreeModel, checkEntitlement } = await import(
  pathToFileURL(join(base, "src/server/plans.ts")).href
);
const { recordUsage } = await import(pathToFileURL(join(base, "src/server/usage.ts")).href);

// --- defaults ---------------------------------------------------------------
// Signing up is enough to be a free user: a missing row is a normal state, not an error.
const fresh = await planFor("newcomer");
assert.equal(fresh.plan, "free", "an account with no row must default to free");
assert.equal(fresh.status, "active");

// --- free tier is :free models only -----------------------------------------
const denied = await checkEntitlement("newcomer", "anthropic/claude-opus-5");
assert.equal(denied.ok, false, "free must not reach a paid model");
assert.equal(denied.status, 403, "a plan restriction is 403, not 402 — it isn't a quota problem");

const allowed = await checkEntitlement("newcomer", "meta-llama/llama-3.3-70b-instruct:free");
assert.equal(allowed.ok, true, "free must be able to run :free models");

// --- the free tier is defined by PRICE, not by the :free suffix ---------------
// The point of the change: :free upstream quota runs dry, so the tier is cheap models we pay for.
assert.equal(isFreeModel("gemini-2.5-flash-lite"), true, "a cheap model is on the free tier");
assert.equal(isFreeModel("claude-opus-4-8"), false, "an expensive model is not");
assert.equal(isFreeModel("some/model-nobody-has-priced"), false, "an unpriced model must fail CLOSED");
process.env.ADA_FREE_MAX_PRICE = "0.01";
assert.equal(isFreeModel("gemini-2.5-flash-lite"), false, "the threshold is tunable without a deploy");
delete process.env.ADA_FREE_MAX_PRICE;

// --- ADA_FREE_MODELS adds specific models to the free tier -------------------
process.env.ADA_FREE_MODELS = "deepseek/deepseek-v4-flash-0731";
assert.equal((await checkEntitlement("newcomer", "deepseek/deepseek-v4-flash-0731")).ok, true, "a listed model must be free-tier usable");
assert.equal((await checkEntitlement("newcomer", "DeepSeek/DeepSeek-V4-Flash-0731")).ok, true, "the list must match case-insensitively");
assert.equal((await checkEntitlement("newcomer", "anthropic/claude-opus-5")).status, 403, "unlisted paid models must stay locked");
delete process.env.ADA_FREE_MODELS;

// --- paid unlocks the catalogue ---------------------------------------------
await setPlan("payer", "pro");
const pro = await checkEntitlement("payer", "anthropic/claude-opus-5");
assert.equal(pro.ok, true, "pro must reach paid models");
assert.equal(pro.capUsd, PLANS.pro.capUsd);

// --- spend cap --------------------------------------------------------------
// Spend the whole allowance, then the next request must be refused. Opus prices in the $5/$25
// per 1M range, so 1M output tokens is far past the $2 cap however the catalogue moves.
const now = Date.now();
await recordUsage({ ts: now, user: "payer", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: 0, completionTokens: 1_000_000 });
const spent = await checkEntitlement("payer", "anthropic/claude-opus-5");
assert.equal(spent.ok, false, "a used-up plan must stop");
assert.equal(spent.status, 402, "out of budget is 402 — payment, not permission");
assert.ok(spent.message.includes("cap reached"), "the message must say why");
assert.ok(spent.usedUsd > PLANS.pro.capUsd, "spend is reported in dollars");

// A window ago does not count: the cap is per 4 hours, not forever.
await setPlan("yesterday", "pro");
await recordUsage({ ts: windowStart() - 1, user: "yesterday", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: 0, completionTokens: 1_000_000 });
assert.equal((await checkEntitlement("yesterday", "anthropic/claude-opus-5")).ok, true, "spend outside the window must not count");

// Quota is per account: one user's spend must never consume another's.
await setPlan("other", "pro");
assert.equal((await checkEntitlement("other", "anthropic/claude-opus-5")).ok, true, "quota must not leak across accounts");

// --- lapsed subscriptions degrade, they don't lock out -----------------------
// An expired card should cost you the paid models, not your account.
await setPlan("lapsed", "pro", "past_due");
const lapsed = await planFor("lapsed");
assert.equal(effectivePlan(lapsed).name, "free", "past_due must fall back to free");
assert.equal((await checkEntitlement("lapsed", "some/model:free")).ok, true, "a lapsed account keeps free access");
assert.equal((await checkEntitlement("lapsed", "anthropic/claude-opus-5")).status, 403, "a lapsed account loses paid models");

// --- an unknown plan string must not grant anything --------------------------
// A typo or a future plan name arriving from a webhook must fail closed.
await setPlan("weird", "free");
const raw = process.env.DATABASE_URL
  ? null
  : (await import("node:module")).createRequire(import.meta.url)("better-sqlite3");
if (raw) {
  const { authDatabase } = await import(pathToFileURL(join(base, "src/server/auth.ts")).href);
  authDatabase().prepare("update user_plans set plan = 'enterprise_unlimited' where user_id = ?").run("weird");
  const { invalidatePlanCache } = await import(pathToFileURL(join(base, "src/server/plans.ts")).href);
  invalidatePlanCache("weird");
  assert.equal((await planFor("weird")).plan, "free", "an unrecognised plan name must degrade to free, not unlock");
}

// --- free-model tokens cost nothing -------------------------------------------
// The cap is on SPEND, so :free models fall out on their own — they price at zero.
await setPlan("freeloader", "pro");
await recordUsage({ ts: Date.now(), user: "freeloader", model: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", promptTokens: 50_000_000, completionTokens: 0 });
const freeSpend = await checkEntitlement("freeloader", "anthropic/claude-opus-5");
assert.equal(freeSpend.ok, true, "free-model tokens must not consume the paid budget");
assert.equal(freeSpend.usedUsd, 0, "a :free model costs $0 however many tokens it burns");

// --- ban ---------------------------------------------------------------------
// Banned means nothing runs, not even free models, and it's 403 — money can't fix it.
await setPlan("outlaw", "pro", "banned");
const banned = await checkEntitlement("outlaw", "some/model:free");
assert.equal(banned.ok, false, "a banned account must not run anything");
assert.equal(banned.status, 403, "banned is 403, not a quota problem");

// --- per-user spend override -------------------------------------------------
// An admin can raise one account's cap past its plan without inventing a plan for it.
await setPlan("vip", "pro", "active", true, null, 500);
await recordUsage({ ts: Date.now(), user: "vip", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: 0, completionTokens: 1_000_000 });
const vip = await checkEntitlement("vip", "anthropic/claude-opus-5");
assert.equal(vip.ok, true, "an override must beat the plan's cap");
assert.equal(vip.capUsd, 500, "the reported cap is the override");
// A later setPlan that says nothing about maxUsd must not wipe the override (webhooks call this).
await setPlan("vip", "pro", "active");
assert.equal((await checkEntitlement("vip", "anthropic/claude-opus-5")).capUsd, 500, "an unrelated setPlan must not wipe the override");
// Explicit null clears it.
await setPlan("vip", "pro", "active", true, null, null);
assert.equal((await checkEntitlement("vip", "anthropic/claude-opus-5")).capUsd, PLANS.pro.capUsd, "null must clear the override");

// --- god mode ----------------------------------------------------------------
// Env-listed admins are never metered or model-gated, even with no plan row and spend past any cap.
process.env.ADA_ADMIN_USERS = "boss";
await recordUsage({ ts: Date.now(), user: "boss", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: 0, completionTokens: 5_000_000 });
const god = await checkEntitlement("boss", "anthropic/claude-opus-5");
assert.equal(god.ok, true, "an env-listed admin must never be blocked");
assert.equal(god.capUsd, null, "god mode is uncapped, not capped-very-high");
assert.ok(god.usedUsd > 0, "god mode still reports spend — unlimited must stay visible");
assert.equal((await checkEntitlement("payer", "anthropic/claude-opus-5")).ok, false, "god mode must not leak to non-admins");
delete process.env.ADA_ADMIN_USERS;

// --- enterprise is uncapped ---------------------------------------------------
// Billed by contract, so metering it is reporting rather than gating.
await setPlan("bigco", "team");
await recordUsage({ ts: Date.now(), user: "bigco", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: 0, completionTokens: 20_000_000 });
const ent = await checkEntitlement("bigco", "anthropic/claude-opus-5");
assert.equal(ent.ok, true, "an enterprise account must never hit a cap");
assert.equal(ent.capUsd, null, "team reports no cap at all");

// --- the spend window --------------------------------------------------------
assert.equal(WINDOW_MS, 4 * 60 * 60 * 1000, "the window is 4 hours");
assert.equal(windowStart(Date.UTC(2026, 7, 2, 13, 59)), Date.UTC(2026, 7, 2, 12), "windows align to fixed 4h buckets");
assert.ok(windowStart() <= Date.now(), "a window can never start in the future");

// --- billing period ---------------------------------------------------------
// No anchor → calendar month, so a free account's window is predictable.
const cal = periodStart({ user: "x", plan: "free", status: "active", periodStart: null }, Date.UTC(2026, 6, 29, 12));
assert.equal(cal, Date.UTC(2026, 6, 1), "an unanchored plan resets on the 1st");

// Anchored → rolls forward whole months from the subscription date, so the window matches what was
// charged rather than drifting to the calendar.
const anchored = periodStart({ user: "y", plan: "pro", status: "active", periodStart: Date.UTC(2026, 0, 15) }, Date.UTC(2026, 6, 20));
assert.equal(anchored, Date.UTC(2026, 6, 15), "an anchored plan resets on its own day of month");

// Before the anchor day, the current period started the previous month — the off-by-one that would
// silently hand out a second allowance.
const midCycle = periodStart({ user: "y", plan: "pro", status: "active", periodStart: Date.UTC(2026, 0, 15) }, Date.UTC(2026, 6, 10));
assert.equal(midCycle, Date.UTC(2026, 5, 15), "before the anchor day the period began last month");

process.chdir(tmpdir());
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* sqlite still holds the file on Windows; the OS reaps tmp */
}
console.log("plans OK");
process.exit(0);
