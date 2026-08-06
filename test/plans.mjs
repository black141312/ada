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
const { PLANS, planFor, setPlan, effectivePlan, periodStart, checkEntitlement } = await import(
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
assert.equal(pro.limit, PLANS.pro.monthlyTokens);

// --- quota ------------------------------------------------------------------
// Spend the whole allowance, then the next request must be refused.
const now = Date.now();
await recordUsage({ ts: now, user: "payer", model: "anthropic/claude-opus-5", provider: "anthropic", promptTokens: PLANS.pro.monthlyTokens, completionTokens: 0 });
const spent = await checkEntitlement("payer", "anthropic/claude-opus-5");
assert.equal(spent.ok, false, "a used-up plan must stop");
assert.equal(spent.status, 402, "out of quota is 402 — payment, not permission");
assert.ok(spent.message.includes("quota reached"), "the message must say why");

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
  authDatabase.prepare("update user_plans set plan = 'enterprise_unlimited' where user_id = ?").run("weird");
  const { invalidatePlanCache } = await import(pathToFileURL(join(base, "src/server/plans.ts")).href);
  invalidatePlanCache("weird");
  assert.equal((await planFor("weird")).plan, "free", "an unrecognised plan name must degrade to free, not unlock");
}

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
