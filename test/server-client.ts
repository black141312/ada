// The flow the user actually wants: the client id lives on the SERVER, and clicking Sign in just
// works. Nobody is ever shown a setup box.
//
// A client id is public — it travels in the consent URL in the user's own browser — so publishing
// it is safe. The SECRET stays on the server and is only used in the token exchange.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { exchangeClients, exchangeHosts, exchangeMisconfigured } from "../src/server/mcp-oauth-exchange.ts";

// --- the server publishes its client id, never its secret ----------------------------------
process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_ID = "ada-shipped.apps.googleusercontent.com";
process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_SECRET = "GOCSPX-SERVER-ONLY";

process.env.ADA_MCP_OAUTH_GITHUB_CLIENT_ID = "Ov23-ada-github";
process.env.ADA_MCP_OAUTH_GITHUB_CLIENT_SECRET = "gh-secret-server-only";
process.env.ADA_MCP_OAUTH_SLACK_CLIENT_ID = "1234.5678-slack";
process.env.ADA_MCP_OAUTH_SLACK_CLIENT_SECRET = "slack-secret-server-only";

const published = exchangeClients();
// One mechanism, three providers — each keyed by the token-endpoint host its exchange talks to.
assert.deepEqual(Object.keys(published).sort(), ["github.com", "oauth2.googleapis.com", "slack.com"]);
assert.equal(published["oauth2.googleapis.com"]!.provider, "google");
assert.equal(published["github.com"]!.client_id, "Ov23-ada-github");
assert.equal(published["github.com"]!.provider, "github");
assert.equal(published["slack.com"]!.provider, "slack");
const asText = JSON.stringify(published);
for (const leak of ["GOCSPX", "gh-secret", "slack-secret"]) assert.ok(!asText.includes(leak), "THE SECRET MUST NEVER BE PUBLISHED");
console.log("server publishes  : client_id + provider, and no secret");

// A fully configured deployment must have nothing to complain about.
assert.deepEqual(exchangeMisconfigured(), [], "all three set = no warnings");
console.log("setup check       : all three complete, nothing half-set");

// --- a stand-in backend serving exactly what the real route serves -------------------------
const backend = createServer((req, res) => {
  if (req.url === "/v1/mcp/oauth/hosts") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hosts: exchangeHosts(), clients: exchangeClients() }));
    return;
  }
  res.writeHead(404).end();
});
const port: number = await new Promise((r) => backend.listen(0, "127.0.0.1", () => r((backend.address() as { port: number }).port)));
process.env.ADA_BACKEND_URL = `http://127.0.0.1:${port}/v1`;

try {
  const oauth = await import("../src/client/mcp-oauth.ts");

  // --- the desktop client picks the id up without anyone pasting it -----------------------
  const c = await oauth.backendClientFor("https://oauth2.googleapis.com/token");
  assert.equal(c?.client_id, "ada-shipped.apps.googleusercontent.com", "client id came from the server");
  assert.equal(await oauth.backendHasProvider("google"), true, "so Google needs no local setup");
  assert.equal(await oauth.backendHasProvider("notion"), false, "and unknown providers are not claimed");
  const gh = await oauth.backendClientFor("https://github.com/login/oauth/access_token");
  assert.equal(gh?.client_id, "Ov23-ada-github", "github's client id resolves by its token host");
  assert.equal(await oauth.backendHasProvider("github"), true);
  assert.equal(await oauth.backendHasProvider("slack"), true);
  console.log("desktop client    : reads the id from the server — no setup box, nothing to paste");

  // --- an endpoint the server holds nothing for is left alone ------------------------------
  assert.equal(await oauth.backendClientFor("https://login.microsoftonline.com/token"), null);
  console.log("unknown endpoint  : no client claimed, sign-in falls back to self-registration");
} finally {
  backend.close();
  delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.ADA_MCP_OAUTH_GOOGLE_CLIENT_SECRET;
  for (const k of ["GITHUB","SLACK"]) { delete process.env['ADA_MCP_OAUTH_'+k+'_CLIENT_ID']; delete process.env['ADA_MCP_OAUTH_'+k+'_CLIENT_SECRET']; }
  delete process.env.ADA_BACKEND_URL;
}

console.log("\nserver-held client: set two env vars on the backend and every user just clicks Sign in");
process.exit(0);
