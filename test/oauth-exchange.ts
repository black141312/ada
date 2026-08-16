// Option B: the backend holds the connector client secret and completes the token exchange, then
// hands the tokens back — they still only ever live on the user's machine.
//
// The property that matters most here is the allowlist. Without it this endpoint is an open relay:
// anyone could post their own `token_endpoint` and have the server attach Ada's secret to it.
import assert from "node:assert/strict";
import { exchangeHosts, handleMcpOauthExchange } from "../src/server/mcp-oauth-exchange.ts";

const GOOGLE = "https://oauth2.googleapis.com/token";

// --- nothing configured: refuse, and say so in a way the client can act on -----------------
delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_ID;
delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_SECRET;
assert.deepEqual(exchangeHosts(), [], "an unconfigured deployment handles nothing");
let r = await handleMcpOauthExchange({ token_endpoint: GOOGLE, code: "x" });
assert.equal(r.status, 404, "404 means 'finish it yourself', which is what the client falls back to");
assert.deepEqual(r.json.hosts, [], "and it reports what it could have handled");
console.log("unconfigured      : 404 + empty host list -> client exchanges locally");

// --- configured: only the hosts we hold credentials for -----------------------------------
process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_ID = "ada-client";
process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_SECRET = "ADA-SECRET";
assert.deepEqual(exchangeHosts(), ["oauth2.googleapis.com"]);

for (const bad of [
  "https://evil.example.com/token",
  "https://oauth2.googleapis.com.evil.example.com/token", // suffix trick
  "https://accounts.google.com/token", // a Google host we hold nothing for
]) {
  const out = await handleMcpOauthExchange({ token_endpoint: bad, code: "x" });
  assert.equal(out.status, 404, `${bad} must be refused`);
}
assert.equal((await handleMcpOauthExchange({ token_endpoint: "http://oauth2.googleapis.com/token" })).status, 400, "plain http refused");
assert.equal((await handleMcpOauthExchange({ token_endpoint: "not a url" })).status, 400);
console.log("open-relay guard  : lookalike hosts, other Google hosts, http and junk all refused");

// --- forwarding: reaches the real endpoint and reports its answer --------------------------
// A 200 needs real credentials, which this test deliberately does not have. Google rejecting the
// fake client IS the proof that the request was built, sent and parsed.
r = await handleMcpOauthExchange({ token_endpoint: GOOGLE, grant_type: "refresh_token", refresh_token: "old" });
assert.ok([400, 401, 502].includes(r.status), `expected a refusal from Google, got ${r.status}`);
assert.ok(r.json.error || r.json.error_description, "and its reason is passed back verbatim");
console.log("forwarding        : reached Google, refused the fake client —", String(r.json.error).slice(0, 40));

delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_ID;
delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_SECRET;
console.log("\noauth exchange: allowlist holds, unconfigured degrades to a local exchange, errors surface");
