// A process that cannot READ the token store must never overwrite it.
//
// This is a data-loss bug, found the hard way: the desktop app writes the store encrypted with a key
// held by the OS keystore, and any other process — `ada` from a terminal, a diagnostic script —
// reads it, gets `{}` because it has no key, and the first write then replaces every sign-in on the
// machine with its own empty view, in plaintext. No error, no prompt. Just gone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-store-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const storeFile = path.join(home, ".ada", "mcp-auth.json");
const url = "https://mcp.example.com/mcp";
const KEY = randomBytes(32).toString("base64");

try {
  // --- the app writes a real, encrypted store -------------------------------------------------
  process.env.ADA_TOKEN_KEY = KEY;
  const app = await import("../src/client/mcp-oauth.ts?app");
  app.setAuth(url, { access_token: "precious", client_id: "c", token_endpoint: "https://t/" });
  const sealed = fs.readFileSync(storeFile, "utf8");
  assert.ok(sealed.startsWith("ada-enc-v1:"), "the app's store is encrypted");
  console.log("app        : signed in, store sealed");

  // --- another process, no key, tries to write ------------------------------------------------
  // A separate module instance, because the lock is per-process state and the point is a DIFFERENT
  // process — `?cli` defeats the module cache so it re-reads the file with no key.
  delete process.env.ADA_TOKEN_KEY;
  const cli = await import("../src/client/mcp-oauth.ts?cli");
  assert.equal(cli.getAuth(url), null, "it genuinely cannot read the store");
  cli.setAuth("https://other.example.com/mcp", { access_token: "x", client_id: "c", token_endpoint: "https://t/" });
  cli.clearAuth(url); // the more destructive half: a sign-out it has no right to perform

  const after = fs.readFileSync(storeFile, "utf8");
  assert.equal(after, sealed, "THE STORE MUST BE BYTE-IDENTICAL — nothing may overwrite what it cannot read");
  assert.ok(after.startsWith("ada-enc-v1:"), "and still encrypted, not flattened to plaintext");
  console.log("other proc : refused to write — store untouched, still sealed");

  // --- the app comes back and its sign-in is still there ---------------------------------------
  process.env.ADA_TOKEN_KEY = KEY;
  const app2 = await import("../src/client/mcp-oauth.ts?app2");
  assert.equal(app2.getAuth(url)?.access_token, "precious", "the original sign-in survived");
  console.log("app again  : sign-in intact");

  // --- and a process WITH the key can still write normally --------------------------------------
  app2.setAuth("https://second.example.com/mcp", { access_token: "second", client_id: "c", token_endpoint: "https://t/" });
  assert.equal(app2.getAuth("https://second.example.com/mcp")?.access_token, "second", "writing still works with the key");
  assert.equal(app2.getAuth(url)?.access_token, "precious", "and does not disturb what was already there");
  console.log("app write  : still works — the guard blocks only the blind case");

  // --- a key that no longer OPENS the store must not brick sign-in forever ---------------------
  // Distinct from the keyless case: here we have a key, it just does not fit — the real situation
  // after a keystore entry is regenerated. Refusing to write, as the keyless path does, would be
  // permanent: every future write hits the same unreadable file and nobody could sign in again.
  process.env.ADA_TOKEN_KEY = randomBytes(32).toString("base64");
  const wrong = await import("../src/client/mcp-oauth.ts?wrong");
  assert.equal(wrong.getAuth(url), null, "it cannot read the store with this key");
  wrong.setAuth(url, { access_token: "new-start", client_id: "c", token_endpoint: "https://t/" });
  assert.equal(wrong.getAuth(url)?.access_token, "new-start", "a fresh store works — not bricked");

  const kept = fs.readdirSync(path.join(home, ".ada")).filter((f) => f.includes("unreadable"));
  assert.equal(kept.length, 1, "the unreadable store was PRESERVED, not deleted");
  assert.ok(
    fs.readFileSync(path.join(home, ".ada", kept[0]!), "utf8").startsWith("ada-enc-v1:"),
    "and it is still the original sealed file, recoverable by whoever holds the old key",
  );
  console.log("wrong key  : old store kept aside, a new one starts — recoverable, not bricked");

  console.log("\ntoken store: a process without the key can read nothing and destroy nothing");
} finally {
  delete process.env.ADA_TOKEN_KEY;
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* temp dir, swept later */
  }
}
process.exit(0);
