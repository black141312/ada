// The callback page must name the service, through the REAL loginConnector path.
// Asserting awaitCallback directly missed that loginConnector was not passing a label at all.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-label-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ada-labelp-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ADA_TOKEN_KEY = randomBytes(32).toString("base64");
delete process.env.ADA_BACKEND_URL;

const PORT = 8996;
const url = `http://127.0.0.1:${PORT}/mcp`;
fs.mkdirSync(path.join(proj, ".ada"), { recursive: true });
// The catalog id is hyphenated and suffixed; the page must show the service's own name.
fs.writeFileSync(path.join(proj, ".ada", "mcp.json"), JSON.stringify({ servers: { "github-remote": { url } } }, null, 2));
process.chdir(proj);

const server = spawn(process.execPath, [path.join(import.meta.dirname, "fake-mcp.mjs"), String(PORT)], { stdio: "ignore", windowsHide: true });
await new Promise((r) => setTimeout(r, 1200));

try {
  const { loginConnector } = await import("../src/client/mcp.ts");
  const started = await loginConnector("github-remote");
  assert.ok(started.ok && started.url, `sign-in did not start: ${started.error}`);
  const redirect = new URL(new URL(started.url!).searchParams.get("redirect_uri")!);
  const state = new URL(started.url!).searchParams.get("state")!;
  const page = await (await fetch(`${redirect.origin}/callback?code=x&state=${encodeURIComponent(state)}`)).text();
  assert.match(page, /Connected to GitHub/, `the page did not name the service:\n${page.slice(0, 200)}`);
  assert.ok(!page.includes("github-remote"), "it shows the service name, not the catalog id");
  console.log("callback page : says \"Connected to GitHub\" — not \"github-remote\", not bare \"Connected\"");
  await new Promise((r) => setTimeout(r, 900));
} finally {
  server.kill();
  process.chdir(os.tmpdir());
  for (const d of [home, proj]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* swept later */ }
  }
}
process.exit(0);
