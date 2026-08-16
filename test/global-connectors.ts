// Connectors belong to the person, not to the checkout.
//
// The bug: `.ada/mcp.json` lived in the project, so Gmail connected while one folder was open did
// not exist for a scheduled task running in another — and because tokens were ALREADY global, a
// connector could report itself signed in and simultaneously not be configured. Same account, same
// machine, two answers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-home-"));
const projA = fs.mkdtempSync(path.join(os.tmpdir(), "ada-projA-"));
const projB = fs.mkdtempSync(path.join(os.tmpdir(), "ada-projB-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ADA_MCP_CONFIG; // exercise the real ~/.ada/mcp.json path

try {
  const mcp = await import("../src/client/mcp.ts");

  // --- connect in one folder ---------------------------------------------------------------
  process.chdir(projA);
  mcp.addConnector("gmail-remote");
  assert.ok(
    mcp.listConnectors().find((c) => c.name === "gmail-remote")?.configured,
    "connected where it was added",
  );
  console.log("folder A      : connected Gmail");

  // --- and it exists in a completely different one -------------------------------------------
  process.chdir(projB);
  assert.ok(
    mcp.listConnectors().find((c) => c.name === "gmail-remote")?.configured,
    "THE WHOLE POINT: a different folder sees the same connector",
  );
  console.log("folder B      : sees it too — no reconnecting per project");

  // It lives in the home directory, not in either project.
  assert.ok(fs.existsSync(path.join(home, ".ada", "mcp.json")), "config is in the home directory");
  for (const p of [projA, projB])
    assert.ok(!fs.existsSync(path.join(p, ".ada", "mcp.json")), `nothing was written into ${path.basename(p)}`);
  console.log("on disk       : one file in ~/.ada, none in the projects");

  // --- EVERY connector, not just the catalog ones ---------------------------------------------
  // A hand-added server is still a connector. If custom ones stayed project-local, "connect once"
  // would be true of Gmail and false of the MCP server someone wired up themselves — which is the
  // same confusion in a smaller box.
  process.chdir(projA);
  mcp.addCustomServer("my-own", { url: "https://mcp.mine.test/mcp" });
  process.chdir(projB);
  const custom = mcp.listConnectors().find((c) => c.name === "my-own");
  assert.ok(custom?.configured, "a custom server is global too");
  assert.equal(custom?.custom, true, "and is still marked as the user's own");
  console.log("custom server : global as well — every connector, not just catalog ones");

  // --- removing is global too, or the two would drift ----------------------------------------
  mcp.removeConnector("gmail-remote");
  process.chdir(projA);
  assert.ok(!mcp.listConnectors().find((c) => c.name === "gmail-remote")?.configured, "removal is global as well");
  console.log("removal       : also global — the two views cannot disagree");

  // --- Remove must forget the SIGN-IN too, not just the config entry ---------------------------
  // Leaving the token behind made Remove a half-measure: re-adding reported itself already signed
  // in, carrying whatever scopes the old token had. So removing a connector in order to
  // re-authorise it handed back the exact token you were trying to replace — and the app, seeing a
  // token, declared the new sign-in finished while the consent screen was still open.
  const oauth = await import("../src/client/mcp-oauth.ts");
  const gmailUrl = "https://gmailmcp.googleapis.com/mcp/v1";
  process.chdir(projA);
  mcp.addConnector("gmail-remote");
  oauth.setAuth(gmailUrl, { access_token: "old-scope-token", client_id: "c", token_endpoint: "https://t/" });
  assert.ok(mcp.hasStoredAuth("gmail-remote"), "signed in before removal");

  mcp.removeConnector("gmail-remote");
  assert.equal(oauth.getAuth(gmailUrl), null, "REMOVE MUST FORGET THE TOKEN, not just the config entry");

  mcp.addConnector("gmail-remote");
  assert.equal(mcp.hasStoredAuth("gmail-remote"), false, "re-adding starts signed OUT — a real consent is required");
  console.log("remove        : forgets the sign-in too — re-adding asks for consent again");

  console.log("\nglobal connectors: connect once, every folder and every scheduled task has it");
} finally {
  process.chdir(os.tmpdir());
  for (const d of [home, projA, projB]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* temp dirs, swept later */
    }
  }
}
process.exit(0);
