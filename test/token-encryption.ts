// Round-trips the connector-token store: plaintext without a key, sealed with one, migrated in
// place, and unreadable to the wrong key. Runs against a temp HOME so the real store is untouched.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-enc-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const storeFile = path.join(home, ".ada", "mcp-auth.json");
const read = () => fs.readFileSync(storeFile, "utf8");

// --- no key: plaintext, exactly as before -------------------------------------------------
delete process.env.ADA_TOKEN_KEY;
let m = await import("../src/client/mcp-oauth.ts");
m.setAuth("https://mcp.example.com/mcp", {
  access_token: "SECRET-TOKEN-AAA",
  refresh_token: "SECRET-REFRESH",
  client_id: "c1",
  token_endpoint: "https://mcp.example.com/token",
});
assert.ok(read().includes("SECRET-TOKEN-AAA"), "without a key the store is plaintext");
console.log("no key            : plaintext (unchanged behaviour)");

// --- migration: an existing plaintext store gets sealed ------------------------------------
const key = randomBytes(32).toString("base64");
process.env.ADA_TOKEN_KEY = key;
m = await import(`../src/client/mcp-oauth.ts?v=2`); // fresh module, fresh env read
assert.equal(m.migrateStoreEncryption(), "encrypted");
const sealed = read();
assert.ok(sealed.startsWith("ada-enc-v1:"), "now sealed");
assert.ok(!sealed.includes("SECRET-TOKEN-AAA"), "the token is no longer readable on disk");
console.log("migration         : plaintext store re-saved encrypted, token no longer on disk");

// --- and still usable -----------------------------------------------------------------------
assert.equal(m.getAuth("https://mcp.example.com/mcp")?.access_token, "SECRET-TOKEN-AAA");
assert.equal(m.migrateStoreEncryption(), "already", "migrating twice is a no-op");
console.log("read back         : token recovered through the key");

// --- new writes stay sealed -----------------------------------------------------------------
m.setAuth("https://other.example.com/mcp", {
  access_token: "SECRET-TOKEN-BBB",
  client_id: "c2",
  token_endpoint: "https://other.example.com/token",
});
assert.ok(!read().includes("SECRET-TOKEN-BBB"), "later writes are sealed too");
console.log("later writes      : sealed");

// --- the wrong key reveals nothing ----------------------------------------------------------
process.env.ADA_TOKEN_KEY = randomBytes(32).toString("base64");
const wrong = await import(`../src/client/mcp-oauth.ts?v=3`);
assert.equal(wrong.getAuth("https://mcp.example.com/mcp"), null, "a different key gets nothing");
console.log("wrong key         : no tokens, no crash");

// --- no key at all against a sealed store ----------------------------------------------------
delete process.env.ADA_TOKEN_KEY;
const nokey = await import(`../src/client/mcp-oauth.ts?v=4`);
assert.equal(nokey.getAuth("https://mcp.example.com/mcp"), null, "sealed store is opaque without the key");
console.log("no key vs sealed  : opaque");

fs.rmSync(home, { recursive: true, force: true });
console.log("\ntoken store encryption: all checks pass");
