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

/** Injected into the page to read and act on the DOM directly.
 *
 *  This is the cheap path. chrome.debugger makes Chrome show "ada bridge started debugging this
 *  browser" and costs a protocol round trip per query; a content script shares the same DOM with
 *  none of that. It runs in the isolated world, so page globals are invisible - but element.click()
 *  and focus() dispatch real DOM events that the page's own handlers receive, which is all that
 *  reading and clicking need. Refs persist on the isolated world's window between calls. */
function adaDom(action, arg) {
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[contenteditable="true"],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="textbox"],[role="option"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const label = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.value || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);

  if (action === "text") return { text: (document.body && document.body.innerText) || "", url: location.href, title: document.title };

  if (action === "snapshot") {
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
    window.__adaRefs = els;
    const lines = els.map((el, i) => {
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name = label(el);
      const r = el.getBoundingClientRect();
      return `${role}${name ? ` "${name}"` : ""} [ref_${i + 1}] @${Math.round(r.x)},${Math.round(r.y)}`;
    });
    return { url: location.href, title: document.title, count: els.length, tree: lines.join("\n") };
  }

  // Resolve a target: ref from the last snapshot, a CSS selector, or visible text.
  const resolve = () => {
    if (arg.ref) {
      const i = Number(String(arg.ref).replace(/^ref_/, "")) - 1;
      const el = (window.__adaRefs || [])[i];
      if (!el || !el.isConnected) throw new Error(`${arg.ref} is stale - snapshot again`);
      return el;
    }
    if (arg.selector) {
      const el = document.querySelector(arg.selector);
      if (!el) throw new Error(`no element matches ${arg.selector}`);
      return el;
    }
    const want = String(arg.find || "").toLowerCase();
    if (!want) throw new Error("need ref, selector or find");
    const all = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
    const exact = all.find((el) => label(el).toLowerCase() === want);
    if (exact) return exact;
    const partial = all.find((el) => label(el).toLowerCase().includes(want));
    if (partial) return partial;
    // Anything at all that shows the text, innermost first - list rows are rarely marked up as
    // interactive, which is exactly the case that defeated clicking by coordinates.
    const deep = [...document.querySelectorAll("body *")].filter(
      (el) => visible(el) && (el.innerText || "").toLowerCase().includes(want) && ![...el.children].some((c) => (c.innerText || "").toLowerCase().includes(want)),
    );
    if (deep.length) return deep[0];
    throw new Error(`nothing shows ${JSON.stringify(arg.find)}`);
  };

  const el = resolve();
  el.scrollIntoView({ block: "center", behavior: "instant" });

  if (action === "click") {
    el.click();
    return { clicked: label(el) || el.tagName, url: location.href };
  }
  if (action === "type") {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, String(arg.text ?? ""));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, String(arg.text ?? ""));
      else el.value = String(arg.text ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { typed: String(arg.text ?? ""), into: label(el) || el.tagName };
  }
  throw new Error(`unknown dom action: ${action}`);
}

async function run(cmd) {
  if (cmd.op === "dom") {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: cmd.tabId },
      world: "ISOLATED",
      args: [cmd.action, cmd.arg || {}],
      func: adaDom,
    });
    if (!res) throw new Error("the page did not run the script");
    return res.result;
  }
  if (cmd.op === "shot") {
    // captureVisibleTab needs no debugger, so no banner and no attach cost.
    const tab = await chrome.tabs.get(cmd.tabId);
    if (!tab.active) await chrome.tabs.update(cmd.tabId, { active: true });
    return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
  }
  if (cmd.op === "navigate") {
    await chrome.tabs.update(cmd.tabId, { url: cmd.url });
    return { ok: true };
  }
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

/** Run one command and post the answer back. Deliberately not awaited by the reader, so a slow
 *  command cannot stall the stream behind it. */
async function handle(cmd, t) {
  let body;
  try {
    body = { id: cmd.id, result: await run(cmd) };
  } catch (e) {
    body = { id: cmd.id, error: String((e && e.message) || e) };
  }
  await fetch(`${BRIDGE}/result`, { method: "POST", body: JSON.stringify({ token: t, ...body }) }).catch(() => {});
}

/** Hold one connection open and read commands as ada writes them.
 *
 *  This replaces a long-poll loop. Polling left a gap: between one poll being answered and the next
 *  going out, a command had nowhere to land, and if Chrome tore this worker down in that window it
 *  waited for the 30s alarm - which looked like the bridge silently ignoring commands. A stream has
 *  no gap, and ada's heartbeat every 15s counts as activity, so the worker is not torn down at all. */
async function connect() {
  const t = await token();
  if (!t) return;
  try {
    const res = await fetch(`${BRIDGE}/stream?token=${encodeURIComponent(t)}`);
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // heartbeat
        const cmd = JSON.parse(line.slice(6));
        if (cmd && cmd.id) handle(cmd, t);
      }
    }
  } catch {
    /* ada restarted or is not running */
  }
  setTimeout(connect, 2000); // reconnect promptly; the alarm is only a backstop
}
const pump = connect;

chrome.runtime.onInstalled.addListener(() => pump());
chrome.runtime.onStartup.addListener(() => pump());
// MV3 tears down idle service workers; a periodic alarm is the supported way to come back.
chrome.alarms.create("ada-pump", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => pump());
pump();
