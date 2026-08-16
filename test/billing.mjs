// Checkout sessions — the handoff that lets the static website act for a signed-in app user.
// Two properties carry the whole design: a session is single-use, and it expires. Break either and
// a leaked upgrade link becomes a free plan.
//   run: node --import tsx test/billing.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-billing-"));
delete process.env.DATABASE_URL;
process.env.ADA_DATA_DIR = dir;
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const { createCheckout, getCheckout, completeCheckout, checkoutUrl } = await import(
  pathToFileURL(join(base, "src/server/billing.ts")).href
);
const { planFor, invalidatePlanCache } = await import(pathToFileURL(join(base, "src/server/plans.ts")).href);

// --- minting ----------------------------------------------------------------
const s = await createCheckout("alice", "pro");
assert.equal(s.user, "alice");
assert.equal(s.status, "pending");
// The id is the only secret in the URL, so it has to be unguessable.
assert.ok(s.id.length >= 40, `session id must be high-entropy, got ${s.id.length} chars`);
const other = await createCheckout("alice", "pro");
assert.notEqual(s.id, other.id, "ids must never repeat");

// Only paid plans; "upgrading" to free is not a purchase.
await assert.rejects(() => createCheckout("alice", "enterprise_unlimited"), /unknown plan/, "unknown plans must be refused at mint time");

// --- lookup -----------------------------------------------------------------
assert.equal((await getCheckout(s.id)).plan, "pro");
assert.equal(await getCheckout("nope"), null, "unknown ids must return null");
assert.equal(await getCheckout(""), null, "an empty id must not query at all");

// --- completion grants the plan --------------------------------------------
assert.equal((await planFor("alice")).plan, "free", "alice starts on free");
assert.equal(await completeCheckout(s.id), true, "a pending session completes");
invalidatePlanCache("alice");
assert.equal((await planFor("alice")).plan, "pro", "completing must grant the plan");
assert.equal((await getCheckout(s.id)).status, "paid");

// --- single use -------------------------------------------------------------
// Providers replay webhooks, out of order and more than once. A second delivery must be a no-op,
// not a second grant or an error.
assert.equal(await completeCheckout(s.id), false, "a spent session must not complete twice");
assert.equal(await completeCheckout("garbage"), false, "an unknown id must be a no-op, not a throw");

// --- expiry -----------------------------------------------------------------
// Age a pending session past its window and it must stop being usable.
const stale = await createCheckout("bob", "team");
const { authDatabase } = await import(pathToFileURL(join(base, "src/server/auth.ts")).href);
authDatabase.prepare("update checkout_sessions set expires_at = ? where id = ?").run(Date.now() - 1000, stale.id);
assert.equal((await getCheckout(stale.id)).status, "expired", "a session past its window reads as expired");
assert.equal(await completeCheckout(stale.id), false, "an expired session must not grant a plan");
invalidatePlanCache("bob");
assert.equal((await planFor("bob")).plan, "free", "bob must not have been upgraded by an expired session");

// --- the URL carries the id and nothing else --------------------------------
const u = checkoutUrl(s.id);
assert.ok(u.includes(encodeURIComponent(s.id)), "the url must carry the session id");
assert.ok(!u.includes("alice"), "the url must not leak who the session belongs to");
assert.ok(!/token|bearer|key=/i.test(u), "the url must never carry a credential");

process.chdir(tmpdir());
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* sqlite keeps the file open on Windows */
}
console.log("billing OK");
process.exit(0);
