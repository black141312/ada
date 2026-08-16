// The whole connector flow, with the token store ENCRYPTED throughout:
//   connect -> sign in (DCR + PKCE + loopback) -> token sealed on disk -> tools reach the agent
//   -> the tool actually runs -> sign out clears it.
//
// Runs against a temp HOME and a local OAuth-protected MCP server, so it touches nothing real and
// needs nobody's account.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-flow-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ada-proj-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ADA_TOKEN_KEY = randomBytes(32).toString("base64");
delete process.env.ADA_BACKEND_URL; // exercise the direct exchange, not the backend path

const PORT = 8993;
const url = `http://127.0.0.1:${PORT}/mcp`;
fs.mkdirSync(path.join(proj, ".ada"), { recursive: true });
fs.writeFileSync(path.join(proj, ".ada", "mcp.json"), JSON.stringify({ servers: { "flow-test": { url } } }, null, 2));
process.chdir(proj);

const { spawn } = await import("node:child_process");
const server = spawn(process.execPath, [path.join(import.meta.dirname, "fake-mcp.mjs"), String(PORT)], {
  stdio: "ignore",
  windowsHide: true,
});
await new Promise((r) => setTimeout(r, 1200));

try {
  const oauth = await import("../src/client/mcp-oauth.ts");
  const mcp = await import("../src/client/mcp.ts");
  const { toolByName } = await import("../src/client/tools.ts");

  // 1. unauthenticated: the server says who can authorize it
  const first = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(first.status, 401);
  console.log("connect        : server answers 401 -> row offers Sign in");

  // 2. sign in — discovery, dynamic registration, PKCE, loopback callback
  const started = await oauth.beginLogin(url, first.headers.get("www-authenticate"));
  assert.ok(!("error" in started), `sign-in could not start: ${(started as { error?: string }).error}`);
  const { url: consent, finish } = started as { url: string; finish: () => Promise<{ ok: boolean; error?: string }> };
  const cu = new URL(consent);
  assert.equal(cu.searchParams.get("code_challenge_method"), "S256");
  assert.ok(cu.searchParams.get("client_id"), "registered itself — nothing pre-provisioned");
  await fetch(consent); // the browser's part
  const done = await finish();
  assert.ok(done.ok, `token exchange failed: ${done.error}`);
  console.log("sign in        : registered, PKCE S256, token exchanged");

  // 3. the store on disk must be sealed, and the token must not appear in it
  const storeFile = path.join(home, ".ada", "mcp-auth.json");
  const raw = fs.readFileSync(storeFile, "utf8");
  assert.ok(raw.startsWith("ada-enc-v1:"), "the store is encrypted");
  assert.ok(!raw.includes("flowtok"), "the access token is not readable on disk");
  console.log("at rest        : store sealed, token not present in the file");

  // 4. and it is still usable through the key
  assert.ok((await oauth.validAccessToken(url))?.startsWith("flowtok"), "readable with the key");

  // 5. the connector's tools reach the agent, authorized by that token
  const before = new Set(toolByName.keys());
  const loaded = await mcp.loadMcpServers(true);
  const added = [...toolByName.keys()].filter((n) => !before.has(n));
  assert.ok(loaded.some((s) => s.includes("flow-test")), `server not loaded: ${loaded.join(", ")}`);
  assert.ok(added.includes("flow-test__whoami"), `tool not registered: ${added.join(", ")}`);
  const out = await toolByName.get("flow-test__whoami")!.run({} as never, { cwd: proj } as never);
  assert.match(JSON.stringify(out), /connected-and-authorized/, "the remote tool ran");
  console.log("tools          : flow-test__whoami registered and returned its answer");

  // 6. sign out
  oauth.clearAuth(url);
  assert.equal(await oauth.validAccessToken(url), null);
  console.log("sign out       : token forgotten");

  console.log("\nconnector flow: connect -> sign in -> sealed at rest -> tools work -> sign out");
} finally {
  // Best-effort: on Windows a just-exited child can still hold the directory, and a cleanup EPERM
  // must not be reported as a failed test.
  server.kill();
  process.chdir(os.tmpdir());
  for (const d of [home, proj]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* the OS still has it — a temp dir, and it will be swept */
    }
  }
}
process.exit(0);
