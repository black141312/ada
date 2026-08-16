// A whole OAuth round-trip against a fake authorization server: 401 discovery, dynamic client
// registration, PKCE, loopback callback, token exchange. Proves the flow Claude Code uses works
// in Ada end to end, without needing anyone's real account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A temp HOME, set BEFORE the module loads so its store path resolves here. This test used to write
// fake tokens straight into the real ~/.ada/mcp-auth.json — running the suite edited the developer's
// own sign-ins. It also masked a real behaviour: with the desktop app's encrypted store in place,
// a keyless process is now correctly refused a write, and the test could not have passed at all.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "ada-e2e-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.on("exit", () => {
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

const oauth = await import("../src/client/mcp-oauth.ts");

const state: Record<string, string> = {};
let registered = 0;

const as = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));

  // The MCP endpoint: 401 with a pointer to its resource metadata.
  if (u.pathname === "/mcp") {
    const auth = req.headers.authorization;
    if (auth === "Bearer real-access-token") return json({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"` }).end();
    return;
  }
  if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`http://127.0.0.1:${port}`] });
  if (u.pathname.startsWith("/.well-known/oauth-authorization-server"))
    return json({
      issuer: `http://127.0.0.1:${port}`,
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      registration_endpoint: `http://127.0.0.1:${port}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  if (u.pathname === "/register") {
    registered++;
    return json({ client_id: "dyn-client-123" });
  }
  if (u.pathname === "/token") {
    let body = "";
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    // PKCE is actually verified — a flow that accepts any verifier proves nothing.
    const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
    assert.equal(challenge, state.challenge, "code_verifier must hash to the challenge sent to /authorize");
    assert.equal(p.get("resource"), state.resource, "RFC 8707 resource must be echoed at the token endpoint");
    assert.equal(p.get("client_id"), "dyn-client-123");
    return json({ access_token: "real-access-token", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
  }
  res.writeHead(404).end();
});

const port: number = await new Promise((r) => as.listen(0, "127.0.0.1", () => r((as.address() as { port: number }).port)));
const serverUrl = `http://127.0.0.1:${port}/mcp`;

// 1. the unauthenticated request that starts everything
const first = await fetch(serverUrl, { method: "POST", body: "{}" });
assert.equal(first.status, 401);
const www = first.headers.get("www-authenticate");
assert.ok(oauth.parseWwwAuthenticate(www), "the 401 advertises where its metadata lives");

// 2. begin the login — discovery + DCR happen inside
const started = await oauth.beginLogin(serverUrl, www);
assert.ok(!("error" in started), `beginLogin failed: ${(started as { error?: string }).error}`);
const { url, finish } = started as { url: string; finish: () => Promise<{ ok: boolean; error?: string }> };
assert.equal(registered, 1, "Ada registered itself — no pre-provisioned client id");

const authUrl = new URL(url);
state.challenge = authUrl.searchParams.get("code_challenge")!;
state.resource = authUrl.searchParams.get("resource")!;
assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
assert.equal(state.resource, `http://127.0.0.1:${port}/mcp`, "token is bound to this exact server");
const redirect = authUrl.searchParams.get("redirect_uri")!;
assert.ok(redirect.startsWith("http://127.0.0.1:"), "loopback redirect, as OAuth 2.1 requires for native apps");

// 3. stand in for the browser: hit the loopback callback the way the AS would
await fetch(`${redirect}?code=auth-code-1&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`);
const done = await finish();
assert.ok(done.ok, `token exchange failed: ${done.error}`);

// 4. the stored token now works against the MCP endpoint
const token = await oauth.validAccessToken(serverUrl);
assert.equal(token, "real-access-token");
const authed = await fetch(serverUrl, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
assert.equal(authed.status, 200, "the server accepts the token Ada obtained");

// 5. a callback with the wrong state is rejected, not accepted
const second = await oauth.beginLogin(serverUrl, www);
const s2 = second as { url: string; finish: () => Promise<{ ok: boolean; error?: string }> };
const badRedirect = new URL(s2.url).searchParams.get("redirect_uri")!;
await fetch(`${badRedirect}?code=x&state=not-the-state-we-sent`);
const rejected = await s2.finish();
assert.equal(rejected.ok, false, "a callback whose state does not match must be refused");
assert.match(rejected.error ?? "", /state mismatch/);

oauth.clearAuth(serverUrl);
assert.equal(await oauth.validAccessToken(serverUrl), null, "sign-out forgets the token");
// Both logins wrote to the real token store — clear the second one too. A test that leaves
// credentials in ~/.ada is a test that quietly pollutes the machine it ran on.
oauth.clearAuth(new URL(s2.url).searchParams.get("resource") ?? serverUrl);
as.close();
console.log("mcp-oauth e2e: discovery, dynamic registration, PKCE, callback, token, refresh store, sign-out — all pass");
