// A session that starts while the extension is down used to be demoted to ada's own scratch profile
// for good: the decision was made once and never revisited, and nothing said so. It then answered
// about a browser the user had never seen — "your open tab" pointing at a logged-out scratch profile.
// Both halves are checked here: that it recovers, and that it says which browser it is in until it does.
//   run: node --import tsx test/bridge-recovery.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A port no real extension dials, so the first check is guaranteed to fail.
const PORT = 9297;
process.env.ADA_BRIDGE_PORT = String(PORT);
process.env.ADA_BROWSER_HEADLESS = "1"; // the fallback launches ada's own browser; keep it invisible
delete process.env.ADA_BROWSER_BRIDGE;

const token = readFileSync(join(homedir(), ".ada", "bridge-token"), "utf8").trim();
const { browserAction } = await import("../src/client/browser.ts");

const page = createServer((_, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<title>t</title><p>hello</p>");
});
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${page.address().port}/`;

/** Enough of the extension to look alive and answer one op. */
async function fakeExtension() {
  const res = await fetch(`http://127.0.0.1:${PORT}/stream?token=${encodeURIComponent(token)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (!line) continue; // heartbeat
      const cmd = JSON.parse(line.slice(6));
      // Answer enough of the protocol that a `text` action completes over the bridge, so the
      // recovery shows up as a clean result rather than as an error from a half-built stub.
      const result =
        cmd.op === "tabs"
          ? [{ id: 1, url: "https://example.com/", title: "example", active: true }]
          : cmd.op === "dom"
            ? { text: "hello from the bridge", url: "https://example.com/", title: "example" }
            : {};
      await fetch(`http://127.0.0.1:${PORT}/result`, {
        method: "POST",
        body: JSON.stringify({ token, id: cmd.id, result }),
      }).catch(() => {});
    }
  }
}

try {
  // --- no extension: falls back, and says so -------------------------------------
  const first = await browserAction("text", { url });
  assert.ok(
    first.text.startsWith("[ada's own browser"),
    `a fallback to the scratch profile must announce itself, got:\n${first.text.slice(0, 200)}`,
  );

  // --- the extension turns up (a reload finished, another ada let go of the port) --
  void fakeExtension();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const again = await browserAction("text", { url });
    if (!again.text.startsWith("[ada's own browser")) {
      console.log("ok");
      process.exit(0);
    }
  }
  assert.fail("the session never noticed the extension come back — it is still latched to the scratch profile");
} finally {
  page.close();
}
