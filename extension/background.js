// The half of ada that lives inside Chrome.
//
// Why this exists: Chrome 136+ refuses --remote-debugging-port (and --remote-debugging-pipe) on the
// profile directory Chrome is actually using, and app-bound cookie encryption means a copied profile
// arrives logged out. An extension is the only remaining way to automate the browser you are already
// signed into: chrome.debugger IS the DevTools protocol, obtained from inside rather than over a port.
//
// It long-polls ada for work rather than ada connecting in, so nothing has to listen for inbound
// connections on your machine, and it speaks only to 127.0.0.1.

const BRIDGE = "http://127.0.0.1:9223";
const attached = new Set();

/** The shared secret ada writes next to this file. Any local process could read it - this keeps
 *  web pages out, not other programs running as you. */
async function token() {
  try {
    const r = await fetch(chrome.runtime.getURL("token.txt"));
    return (await r.text()).trim();
  } catch {
    return "";
  }
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}

chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

/** Forward CDP events (console output, exceptions) so ada's `console` verb has something to read. */
chrome.debugger.onEvent.addListener(async (src, method, params) => {
  try {
    await fetch(`${BRIDGE}/event`, {
      method: "POST",
      body: JSON.stringify({ token: await token(), tabId: src.tabId, method, params }),
    });
  } catch {
    /* ada went away; nothing to do */
  }
});

async function run(cmd) {
  if (cmd.op === "tabs") {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
  }
  if (cmd.op === "activate") {
    await chrome.tabs.update(cmd.tabId, { active: true });
    return { ok: true };
  }
  if (cmd.op === "newTab") {
    const t = await chrome.tabs.create({ url: cmd.url || "about:blank" });
    return { id: t.id };
  }
  if (cmd.op === "closeTab") {
    await chrome.tabs.remove(cmd.tabId);
    return { ok: true };
  }
  if (cmd.op === "cdp") {
    await attach(cmd.tabId);
    return await chrome.debugger.sendCommand({ tabId: cmd.tabId }, cmd.method, cmd.params || {});
  }
  if (cmd.op === "detach") {
    if (attached.has(cmd.tabId)) await chrome.debugger.detach({ tabId: cmd.tabId });
    attached.delete(cmd.tabId);
    return { ok: true };
  }
  throw new Error(`unknown op: ${cmd.op}`);
}

/** Long-poll ada for the next command, run it, post the result, repeat. A dropped connection is
 *  normal (MV3 kills idle service workers); the alarm below wakes us up again. */
async function pump() {
  const t = await token();
  if (!t) return;
  let res;
  try {
    res = await fetch(`${BRIDGE}/poll?token=${encodeURIComponent(t)}`);
  } catch {
    // ada is not running (or just restarted). Waiting for the 30s alarm would make every ada start
    // look like "no extension" for half a minute, so retry soon instead.
    setTimeout(pump, 2000);
    return;
  }
  if (!res.ok) {
    setTimeout(pump, 2000);
    return;
  }
  const cmd = await res.json().catch(() => null);
  if (!cmd || !cmd.id) {
    pump();
    return;
  }
  let body;
  try {
    body = { id: cmd.id, result: await run(cmd) };
  } catch (e) {
    body = { id: cmd.id, error: String((e && e.message) || e) };
  }
  await fetch(`${BRIDGE}/result`, { method: "POST", body: JSON.stringify({ token: t, ...body }) }).catch(() => {});
  pump(); // straight back to waiting
}

chrome.runtime.onInstalled.addListener(() => pump());
chrome.runtime.onStartup.addListener(() => pump());
// MV3 tears down idle service workers; a periodic alarm is the supported way to come back.
chrome.alarms.create("ada-pump", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => pump());
pump();
