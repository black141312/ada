// Smoke test for the Ink TUI: runs it in a real pty with a stub agent, sends a message,
// checks the reply streams and the app exits cleanly. Run: node test/ink-tui-smoke.mjs
import assert from "node:assert";
import { spawn } from "node-pty";

const pty = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "test/ink-tui-stub.mjs"], {
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
});
let out = "";
pty.onData((d) => (out += d));

const until = (re, ms = 15000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (re.test(out)) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${re}\n--- output ---\n${out}`)); }
    }, 100);
  });

await until(/Ask me to build/);
pty.write("hello");
await new Promise((r) => setTimeout(r, 300));
pty.write("\r"); // Enter as its own keystroke — Ink parses per-chunk
await until(/stub reply to: hello/);
pty.write("/exit");
await new Promise((r) => setTimeout(r, 300));
pty.write("\r");
await Promise.race([
  new Promise((res) => pty.onExit(res)),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`app did not exit\n--- tail ---\n${JSON.stringify(out.slice(-800))}`)), 10000)),
]);
assert.match(out, /›/);
console.log("ok");
process.exit(0);
