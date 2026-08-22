// Usage has to survive a restart to be billable. The file writer in enterprise.ts doesn't — Cloud
// Run's disk is ephemeral — so metering now also lands in the database. This exercises that path
// against sqlite; Postgres takes the same SQL shape (same split as allowlist.ts).
//   run: node --import tsx test/usage-db.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// auth.ts picks sqlite when DATABASE_URL is unset; point its file somewhere disposable.
const dir = mkdtempSync(join(tmpdir(), "ada-usage-"));
delete process.env.DATABASE_URL;
process.env.ADA_DATA_DIR = dir;
process.chdir(dir);

const { recordUsage, usageSince, usageByModel } = await import(pathToFileURL(resolve(import.meta.dirname, "../src/server/usage.ts")).href);

const now = Date.now();
const HOUR = 3600_000;

await recordUsage({ ts: now, user: "alice", model: "claude-opus-5", provider: "anthropic", promptTokens: 1000, completionTokens: 100 });
await recordUsage({ ts: now, user: "alice", model: "claude-opus-5", provider: "anthropic", promptTokens: 500, completionTokens: 50 });
await recordUsage({ ts: now, user: "alice", model: "gpt-5.5", provider: "openai", promptTokens: 200, completionTokens: 20 });
await recordUsage({ ts: now - 48 * HOUR, user: "alice", model: "gpt-5.5", provider: "openai", promptTokens: 9999, completionTokens: 9999 });
await recordUsage({ ts: now, user: "bob", model: "gpt-5.5", provider: "openai", promptTokens: 7, completionTokens: 7 });

// --- the number a quota is checked against ---------------------------------
const alice = await usageSince("alice", now - HOUR);
assert.equal(alice.promptTokens, 1700, "prompt tokens must sum across rows in the window");
assert.equal(alice.completionTokens, 170, "completion tokens must sum across rows in the window");
assert.equal(alice.requests, 3, "the 48h-old row must fall outside a 1h window");

// Billing periods are per account. One user's spend must never land on another's quota.
const bob = await usageSince("bob", now - HOUR);
assert.equal(bob.promptTokens, 7, "usage must be scoped to the account");
assert.equal(bob.requests, 1);

// A wider window picks the old row back up — proof the filter is the timestamp, not a delete.
const wide = await usageSince("alice", now - 72 * HOUR);
assert.equal(wide.requests, 4, "widening the window must include the older row");
assert.equal(wide.promptTokens, 1700 + 9999);

// An account with no rows is zero, not undefined — a quota check divides by this.
const nobody = await usageSince("carol", 0);
assert.deepEqual(nobody, { promptTokens: 0, completionTokens: 0, requests: 0 }, "unknown account must total zero");

// --- per-model breakdown (cost needs the model, which is why it's stored per row) ---
const byModel = await usageByModel("alice", now - HOUR);
const opus = byModel.find((r) => r.model === "claude-opus-5");
assert.equal(opus.requests, 2, "per-model grouping must aggregate matching rows");
assert.equal(opus.promptTokens, 1500);
assert.equal(byModel.find((r) => r.model === "gpt-5.5").requests, 1);

// --- cost: the number the spend cap is actually checked against ---------------
// Tokens are stored; dollars are derived at read time. Get this wrong and the cap either never
// fires or fires on the wrong people.
const { costSince, priceUsd } = await import(pathToFileURL(resolve(import.meta.dirname, "../src/server/usage.ts")).href);

// A :free model costs nothing however many tokens it burns — that is what makes the free tier free.
assert.deepEqual(priceUsd("meta-llama/llama-3.3-70b-instruct:free"), [0, 0], ":free prices at zero");
// An id nobody has priced must be treated as EXPENSIVE. The other way round, one unrecognised model
// id silently uncaps an account.
const unknown = priceUsd("some-vendor/model-nobody-has-heard-of");
assert.ok(unknown[0] > 1 && unknown[1] > 1, "an unpriced model must cost a lot, not nothing");

await recordUsage({ ts: now, user: "costed", model: "claude-opus-4-8", provider: "anthropic", promptTokens: 1_000_000, completionTokens: 1_000_000 });
await recordUsage({ ts: now, user: "costed", model: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", promptTokens: 9_000_000, completionTokens: 9_000_000 });
const cost = await costSince("costed", now - 1000);
const [pin, pout] = priceUsd("claude-opus-4-8");
assert.ok(Math.abs(cost.usd - (pin + pout)) < 1e-9, "1M in + 1M out costs exactly the per-1M prices");
assert.equal(cost.promptTokens, 10_000_000, "tokens still total across every model, priced or not");

// Spend is per account and per window — the two ways a cap leaks.
assert.equal((await costSince("nobody-else", now - 1000)).usd, 0, "spend must not leak across accounts");
assert.equal((await costSince("costed", now + 1000)).usd, 0, "spend outside the window must not count");

// --- metering must never break a request ------------------------------------
// The call sites sit in response teardown, where a rejection has nobody to catch it.
await assert.doesNotReject(
  () => recordUsage({ ts: now, user: "dave", model: null, provider: undefined, promptTokens: NaN, completionTokens: 0 }),
  "a malformed row must be swallowed, not thrown into a response stream",
);

// Best-effort: Windows keeps a lock on the open sqlite file, and the OS reaps tmp anyway. A
// cleanup failure must not read as a test failure.
process.chdir(tmpdir());
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* still open — leave it to the OS */
}
console.log("usage-db OK");
process.exit(0);
