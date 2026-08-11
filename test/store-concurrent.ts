// Two processes writing the token store at once must not lose each other's sign-ins.
//
// Found live, the expensive way. setAuth was `read the whole file → change one entry → write the
// whole file back`, with no lock. Ada runs several processes against that one file — the desktop
// engine, a scheduled run in another folder, `ada` from a terminal — and when two interleave, the
// second write is built on a snapshot taken before the first, so it silently deletes what the first
// had just added. The symptom is a sign-in that visibly succeeded and then simply is not there.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ada-race-"));
const KEY = randomBytes(32).toString("base64");
const WRITERS = 8;

// Each child writes ONE distinct entry. Nothing is shared but the file, which is the point.
const child = path.join(home, "writer.mjs");
fs.writeFileSync(
  child,
  `
import { register } from ${JSON.stringify(new URL("../node_modules/tsx/dist/esm/api/index.mjs", import.meta.url).href)};
register();
const { setAuth } = await import(${JSON.stringify(new URL("../src/client/mcp-oauth.ts", import.meta.url).href)});
const n = process.argv[2];
setAuth("https://server-" + n + ".example.com/mcp", {
  access_token: "tok-" + n, client_id: "c", token_endpoint: "https://t/",
});
`,
);

try {
  // spawn, NOT spawnSync: spawnSync blocks until each child exits, so the writers ran strictly one
  // after another and the race test raced nothing — it passed with the lock removed.
  const kids = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => {
      const p = spawn(process.execPath, [child, String(i)], {
        env: { ...process.env, HOME: home, USERPROFILE: home, ADA_TOKEN_KEY: KEY },
        windowsHide: true,
      });
      let err = "";
      p.stderr.on("data", (d) => (err += String(d)));
      return new Promise<{ code: number | null; err: string }>((res) => p.on("exit", (code) => res({ code, err })));
    }),
  );
  const failed = kids.filter((k) => k.code !== 0);
  assert.equal(failed.length, 0, `writers failed: ${failed.map((f) => f.err).join(" | ").slice(0, 300)}`);

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ADA_TOKEN_KEY = KEY;
  const { getAuth } = await import("../src/client/mcp-oauth.ts");

  const missing: number[] = [];
  for (let i = 0; i < WRITERS; i++) if (!getAuth(`https://server-${i}.example.com/mcp`)) missing.push(i);

  assert.deepEqual(missing, [], `${missing.length} of ${WRITERS} sign-ins were LOST to the race`);
  console.log(`${WRITERS} concurrent writers : all ${WRITERS} sign-ins survived`);

  // And the lock must not be left behind, or the next writer waits 2s for nothing.
  assert.ok(!fs.existsSync(path.join(home, ".ada", "mcp-auth.json.lock")), "the lock file is released");
  console.log("lock                : released, not left holding the door");

  console.log("\nconcurrent writes: one process's sign-in cannot delete another's");
} finally {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* temp dir */
  }
}
process.exit(0);
