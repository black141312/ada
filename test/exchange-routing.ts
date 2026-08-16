// Where the client secret lives, proved end to end.
//
// The shape the desktop must never have: app -> provider, carrying Ada's secret. Anyone who reads
// the app bundle or a config file then owns Ada's OAuth identity. The shape it must have instead:
//
//   app -> ada backend -> provider          (the backend adds the secret; it holds it, we never do)
//       <- token -------------------        (and hands the token straight back, keeping nothing)
//
// So this asserts three separate things, because two of them passing means nothing on their own:
//   1. the provider was called BY THE BACKEND, with the secret,
//   2. the desktop's own request carried NO secret,
//   3. the token still ended up encrypted on this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-route-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ADA_TOKEN_KEY = randomBytes(32).toString("base64");

const SECRET = "ADA-SHARED-SECRET-NEVER-ON-A-CLIENT";
const PROVIDER_PORT = 8994;
const BACKEND_PORT = 8995;

const read = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });

// --- the upstream provider: refuses to mint a token without the secret ----------------------
const providerCalls: Record<string, string>[] = [];
const provider = createServer(async (req, res) => {
  const body = Object.fromEntries(new URLSearchParams(await read(req)));
  providerCalls.push(body);
  if (body.client_secret !== SECRET) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_client" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "tok-routed", refresh_token: "ref-routed", expires_in: 3600 }));
});

// --- Ada's backend: holds the secret, spends it, keeps nothing -------------------------------
const backendCalls: Record<string, unknown>[] = [];
const backend = createServer(async (req, res) => {
  if (req.url?.endsWith("/mcp/oauth/hosts")) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hosts: ["127.0.0.1"], clients: {} }));
    return;
  }
  if (req.url?.endsWith("/mcp/oauth/exchange")) {
    const j = JSON.parse(await read(req)) as Record<string, unknown>;
    backendCalls.push(j);
    const { token_endpoint, ...rest } = j as { token_endpoint: string };
    // The secret is added HERE, from the backend's environment — never sent up by the caller.
    const up = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...(rest as Record<string, string>), client_secret: SECRET }).toString(),
    });
    res.writeHead(up.status, { "content-type": "application/json" }).end(await up.text());
    return;
  }
  res.writeHead(404).end("{}");
});

await new Promise<void>((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));
await new Promise<void>((r) => backend.listen(BACKEND_PORT, "127.0.0.1", r));
process.env.ADA_BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}/v1`;

try {
  const oauth = await import("../src/client/mcp-oauth.ts");
  const tokenEndpoint = `http://127.0.0.1:${PROVIDER_PORT}/token`;

  const out = await oauth.tokenRequest({ authorization_endpoint: "http://127.0.0.1/a", token_endpoint: tokenEndpoint }, {
    grant_type: "authorization_code",
    code: "the-code",
    client_id: "ada-public-client-id",
    code_verifier: "v".repeat(43),
  });

  assert.equal(out.error, undefined, `exchange failed: ${out.error}`);
  assert.equal(out.access_token, "tok-routed", "the token came back to this machine");
  console.log("round trip    : app -> ada backend -> provider -> token back to the app");

  // 1. it went THROUGH the backend, exactly once
  assert.equal(backendCalls.length, 1, "the desktop called Ada's backend to do the exchange");
  assert.equal(providerCalls.length, 1, "and the provider was hit once, by the backend");

  // 2. the desktop's own request carried no secret — this is the whole point
  const fromDesktop = backendCalls[0]!;
  assert.equal(fromDesktop.client_secret, undefined, "THE DESKTOP MUST NOT SEND A CLIENT SECRET");
  assert.ok(!JSON.stringify(fromDesktop).includes(SECRET), "THE SECRET MUST NOT APPEAR IN THE DESKTOP'S REQUEST");
  assert.equal(fromDesktop.code_verifier, "v".repeat(43), "PKCE still proves the desktop started this flow");
  console.log("desktop sends : code + PKCE verifier + public client id — and no secret");

  // 3. only the backend's call to the provider carries it
  assert.equal(providerCalls[0]!.client_secret, SECRET, "the backend supplied the secret");
  console.log("backend adds  : the secret, from its own environment");

  // 4. and the token is stored sealed, on this machine
  oauth.setAuth(tokenEndpoint, { access_token: out.access_token!, refresh_token: out.refresh_token, client_id: "ada-public-client-id", token_endpoint: tokenEndpoint });
  const raw = fs.readFileSync(path.join(home, ".ada", "mcp-auth.json"), "utf8");
  assert.ok(raw.startsWith("ada-enc-v1:"), "the store is encrypted");
  assert.ok(!raw.includes("tok-routed"), "the token is not readable on disk");
  assert.equal((await oauth.getAuth(tokenEndpoint))?.access_token, "tok-routed", "and it is usable with the key");
  console.log("at rest       : token sealed on this machine, backend kept nothing");

  // 5. a client secret present locally would bypass the backend — so nothing may put one there.
  //    setConnectorOauthClient is the only writer, and it no longer accepts one.
  const mcpSrc = fs.readFileSync(new URL("../src/client/mcp.ts", import.meta.url), "utf8");
  assert.ok(!/client_secret/.test(mcpSrc), "the connector config layer must have no client_secret at all");
  console.log("no local path : nothing can write a shared secret into .ada/mcp.json");

  console.log("\nexchange routing: the secret lives on the backend and is spent there — never on the app");
} finally {
  provider.close();
  backend.close();
  delete process.env.ADA_BACKEND_URL;
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* temp dir, swept later */
  }
}
process.exit(0);
