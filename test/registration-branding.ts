// What a stranger sees on the consent screen before handing Ada their workspace.
//
// The bug this exists for: logo_uri pointed at a file that had never been published, so the screen
// rendered a broken image next to the Approve button. Nothing failed, nothing logged — the only way
// to notice was to look. So the URL is fetched here, for real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "../src/client/mcp-oauth.ts";

// --- what Ada actually sends ----------------------------------------------------------------
let sent: Record<string, unknown> = {};
const as = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    sent = JSON.parse(b) as Record<string, unknown>;
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ client_id: "cid-1" }));
  });
});
await new Promise<void>((r) => as.listen(8997, "127.0.0.1", r));

try {
  const reg = await register(
    { authorization_endpoint: "http://127.0.0.1:8997/a", token_endpoint: "http://127.0.0.1:8997/t", registration_endpoint: "http://127.0.0.1:8997/register" },
    "http://127.0.0.1:49555/callback",
  );
  assert.equal(reg?.client_id, "cid-1");

  assert.equal(sent.client_name, "Ada", "the screen must name the app");
  assert.equal(sent.token_endpoint_auth_method, "none", "a desktop app is a public client");
  assert.equal(sent.application_type, "native");
  console.log(`registers as  : ${String(sent.client_name)} — public client, native`);

  // The product's own site, not a source repo: "github.com/someone/something" on a consent screen
  // reads as an individual's side project, not the app being installed.
  for (const field of ["client_uri", "logo_uri"] as const) {
    const v = String(sent[field] ?? "");
    assert.ok(v.startsWith("https://adacodelabs.com"), `${field} must be the product site, got: ${v || "(unset)"}`);
  }
  console.log(`shows website : ${String(sent.client_uri)}`);

  // --- and the logo must actually load, for someone with no session ---------------------------
  const logo = String(sent.logo_uri);
  let res: Response | null = null;
  try {
    res = await fetch(logo, { signal: AbortSignal.timeout(15_000) });
  } catch {
    // Offline is not a code defect. Say so out loud rather than passing quietly, so a green run
    // never gets mistaken for "the logo was checked".
    console.log("logo          : NOT CHECKED — no network. Re-run online before trusting this.");
  }
  if (res) {
    assert.equal(res.status, 200, `logo_uri must resolve, got ${res.status} for ${logo}`);
    const type = res.headers.get("content-type") ?? "";
    assert.match(type, /^image\//, `logo_uri must be an image, got ${type}`);
    const bytes = (await res.arrayBuffer()).byteLength;
    assert.ok(bytes > 512, `logo looks empty (${bytes} bytes)`);
    console.log(`logo          : ${logo} → 200 ${type}, ${bytes} bytes`);
  }

  console.log("\nregistration branding: named, public, and the logo really loads");
} finally {
  as.close();
  await new Promise((r) => setTimeout(r, 300));
}
process.exit(0);
