// Start the bridge and prove it can drive the real, already-logged-in browser.
// Run with: npm run browser:bridge
import { Bridge, isAttachable } from "./client/bridge.ts";

const bridge = await Bridge.start();
console.log(`ada bridge listening on 127.0.0.1:9223\n`);
console.log(`Load the extension once, in YOUR normal Chrome:`);
console.log(`  1. open  chrome://extensions`);
console.log(`  2. turn on "Developer mode" (top right)`);
console.log(`  3. "Load unpacked" -> ${bridge.extensionDir}`);
console.log(`\nWaiting for the extension to connect...`);

const started = Date.now();
while (!bridge.connected && Date.now() - started < 120_000) await new Promise((r) => setTimeout(r, 500));
if (!bridge.connected) {
  console.log(`\nNo connection after 2 minutes. Check chrome://extensions for errors under "ada bridge".`);
  bridge.close();
  process.exit(1);
}

console.log(`\nconnected. Tabs in your real browser:\n`);
const tabs = await bridge.tabs();
for (const t of tabs) {
  const mark = isAttachable(t.url) ? (t.active ? "*" : " ") : "-";
  console.log(`  ${String(t.id).padEnd(12)}${mark} ${(t.title ?? "").slice(0, 50).padEnd(50)} ${(t.url ?? "").slice(0, 60)}`);
}

// Prove CDP works through the extension: read the page's own state back out of a real tab.
// chrome:// pages are marked "-" above and skipped - the debugger is not allowed to attach there.
let target = (await bridge.targets())[0];
if (!target) {
  // Nothing attachable open - make one. This is also the proof that matters: a tab opened here
  // lands in the user's real, already-signed-in profile, not in a scratch one.
  const site = process.argv[2] ?? "https://www.linkedin.com/feed/";
  console.log(`\nNo attachable tab open - opening ${site} in your real browser...`);
  await bridge.call("newTab", { url: site });
  for (let i = 0; i < 30 && !target; i++) {
    await new Promise((r) => setTimeout(r, 500));
    target = (await bridge.targets())[0];
  }
}
if (!target) {
  console.log(`\nStill no attachable tab - check chrome://extensions for errors under "ada bridge".`);
} else {
  try {
    const r = (await bridge.cdp(target.id, "Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title, cookieChars: document.cookie.length})",
      returnByValue: true,
    })) as { result?: { value?: string } };
    console.log(`\nCDP through the extension, on tab ${target.id}:\n  ${r.result?.value ?? "(no answer)"}`);
  } catch (e) {
    console.log(`\nCDP call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\nBridge is up. Leave this running while ada drives the browser.`);
console.log(`Press Ctrl+C to stop.`);
