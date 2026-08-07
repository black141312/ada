// Drive a real browser so the agent can look at what it just built: navigate, screenshot, read the
// rendered text, read the console — and now act on it: read the accessibility tree, then click,
// type, press keys, and scroll by ref. Speaks the Chrome DevTools Protocol directly over the debug
// port — node has fetch and WebSocket built in, so this costs no dependency (puppeteer/playwright
// would each add >100MB and a bundled browser to an app that already ships an Electron one).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.ADA_CDP_PORT) || 9222;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Where Chrome/Edge usually lives, per platform. First hit wins; $ADA_BROWSER overrides. */
function browserPaths(): string[] {
  if (process.env.ADA_BROWSER) return [process.env.ADA_BROWSER];
  const p = process.platform;
  if (p === "win32") {
    const bases = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]].filter(Boolean) as string[];
    return bases.flatMap((b) => [join(b, "Google/Chrome/Application/chrome.exe"), join(b, "Microsoft/Edge/Application/msedge.exe")]);
  }
  if (p === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

async function debuggerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${ORIGIN}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Reuse an already-running debug browser, else start a headless one in a scratch profile. Never
 *  touches the user's real profile — that would fight with their open windows and their cookies. */
async function ensureBrowser(): Promise<void> {
  if (await debuggerUp()) return;
  const exe = browserPaths().find((p) => existsSync(p));
  if (!exe) throw new Error(`no Chrome/Edge found. Install one, or set ADA_BROWSER to its path (or start any Chrome with --remote-debugging-port=${PORT}).`);
  const profile = await mkdtemp(join(tmpdir(), "ada-cdp-"));
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await debuggerUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`started ${exe} but its debug port never opened`);
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Last tab this tool selected (via tab_new/tab_select). Acting defaults to it while it lives. */
let selectedTabId: string | null = null;

/** ref_N → backendDOMNodeId per tab, with the URL the refs were read from. */
const refState = new Map<string, { url: string; refs: Map<string, number> }>();

async function listPages(): Promise<Target[]> {
  const list = (await (await fetch(`${ORIGIN}/json/list`)).json()) as Target[];
  return list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

async function resolveTarget(tab?: string): Promise<Target> {
  const pages = await listPages();
  if (tab) {
    const t = pages.find((p) => p.id === tab);
    if (!t) throw new Error(`no such tab: ${tab} — list with \`tabs\``);
    return t;
  }
  const sel = selectedTabId ? pages.find((p) => p.id === selectedTabId) : undefined;
  if (sel) return sel;
  if (pages[0]) return pages[0];
  const made = (await (await fetch(`${ORIGIN}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
  if (!made.webSocketDebuggerUrl) throw new Error("could not open a page target");
  return made;
}

/** A tab list is something a model reads; origins only — titles are page-authored text. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === "null" ? u.protocol : u.origin;
  } catch {
    return "(unknown)";
  }
}

export async function tabAction(action: "tabs" | "tab_new" | "tab_select" | "tab_close", tab?: string): Promise<string> {
  await ensureBrowser();
  if (action === "tabs") {
    const pages = await listPages();
    return pages.map((p) => `${p.id}${p.id === selectedTabId ? " *" : ""}  ${originOf(p.url)}`).join("\n") || "(no tabs)";
  }
  if (action === "tab_new") {
    const made = (await (await fetch(`${ORIGIN}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
    selectedTabId = made.id;
    return `opened tab ${made.id}`;
  }
  if (!tab) throw new Error(`${action} needs a tab id — list with \`tabs\``);
  if (!(await listPages()).some((p) => p.id === tab)) throw new Error(`no such tab: ${tab} — list with \`tabs\``);
  if (action === "tab_select") {
    await fetch(`${ORIGIN}/json/activate/${tab}`);
    selectedTabId = tab;
    return `selected tab ${tab}`;
  }
  await fetch(`${ORIGIN}/json/close/${tab}`);
  refState.delete(tab);
  if (selectedTabId === tab) selectedTabId = null;
  return `closed tab ${tab}`;
}

type Json = Record<string, unknown>;

/** One CDP session: send commands, collect console/exception events, close. */
class Cdp {
  private ws: WebSocket;
  private id = 0;
  private waiters = new Map<number, { ok: (v: Json) => void; fail: (e: Error) => void }>();
  readonly logs: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as Json & { id?: number; method?: string; params?: Json; error?: { message?: string } };
      if (typeof msg.id === "number") {
        const w = this.waiters.get(msg.id);
        this.waiters.delete(msg.id);
        if (w) msg.error ? w.fail(new Error(msg.error.message ?? "cdp error")) : w.ok((msg.result as Json) ?? {});
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const p = msg.params as { type?: string; args?: { value?: unknown; description?: string }[] };
        const text = (p.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
        this.logs.push(`[${p.type ?? "log"}] ${text}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const p = msg.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
        this.logs.push(`[error] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "uncaught exception"}`);
      } else if (msg.method === "Log.entryAdded") {
        const e = (msg.params as { entry?: { level?: string; text?: string; url?: string } }).entry;
        if (e && e.level !== "verbose") this.logs.push(`[${e.level}] ${e.text}${e.url ? ` (${e.url})` : ""}`);
      }
    });
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => fail(new Error("could not attach to the browser")), { once: true });
    });
    const c = new Cdp(ws);
    await c.send("Runtime.enable");
    await c.send("Log.enable");
    return c;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.id;
    return new Promise<Json>((ok, fail) => {
      this.waiters.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiters.delete(id)) fail(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---- accessibility tree → refs ----

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "tab", "menuitem", "slider", "switch"]);

/** Serialize Accessibility.getFullAXTree output to an indented outline; interactive nodes get
 *  ref_N tags mapping to their backendDOMNodeId. Pure — unit-tested offline in selfcheck. */
export function formatAxTree(nodes: AxNode[]): { text: string; refs: Map<string, number> } {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  const walk = (n: AxNode, depth: number): void => {
    let d = depth;
    if (!n.ignored) {
      const role = n.role?.value ?? "";
      const name = String(n.name?.value ?? "").trim();
      const val = n.value?.value;
      // unnamed layout wrappers add depth, not information — flatten them
      const boring = (role === "generic" || role === "none" || role === "InlineTextBox") && !name;
      if (!boring) {
        let line = `${"  ".repeat(depth)}${role || "node"}${name ? ` "${name}"` : ""}`;
        if (val !== undefined && val !== "") line += ` = ${JSON.stringify(String(val))}`;
        if (INTERACTIVE.has(role) && n.backendDOMNodeId !== undefined) {
          const ref = `ref_${refs.size + 1}`;
          refs.set(ref, n.backendDOMNodeId);
          line += ` [${ref}]`;
        }
        lines.push(line);
        d = depth + 1;
      }
    }
    for (const c of n.childIds ?? []) {
      const k = byId.get(c);
      if (k) walk(k, d);
    }
  };
  for (const r of nodes.filter((n) => !n.parentId || !byId.has(n.parentId))) walk(r, 0);
  return { text: lines.join("\n"), refs };
}

/** CDP key event parameters for the supported `press` keys, by lowercase name. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

/** Resolve a `press` name — named key, or any single printable character (games want WASD,
 *  digits, space). Pure — unit-tested offline in test/game-keys.mjs. */
export function keyParams(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const k = KEYS[name.toLowerCase()];
  if (k) return k;
  if (name.length === 1 && name >= " " && name <= "~") {
    const up = name.toUpperCase();
    const code = name === " " ? "Space" : /[a-z]/i.test(name) ? `Key${up}` : /[0-9]/.test(name) ? `Digit${name}` : "";
    return { key: name, code, keyCode: name === " " ? 32 : up.charCodeAt(0), text: name };
  }
  throw new Error(`unsupported key: ${name || "(none)"}. Supported: any single character, or ${Object.values(KEYS).map((v) => v.key).join(", ")}`);
}

/** Send keyDown/keyUp for a `press` key, optionally holding between the two (games read held keys). */
async function pressKey(cdp: Cdp, name: string, hold = 0): Promise<void> {
  const k = keyParams(name);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) });
  const ms = Math.min(Math.max(Number(hold) || 0, 0), 2000);
  if (ms) await new Promise((r) => setTimeout(r, ms));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

export interface BrowserResult {
  text: string;
  screenshot?: Buffer;
}

export type BrowserVerb = "open" | "screenshot" | "text" | "console" | "read" | "click" | "type" | "press" | "scroll";

export interface BrowserOpts {
  url?: string;
  width?: number;
  height?: number;
  tab?: string;
  ref?: string;
  x?: number;
  y?: number;
  hold?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

/** Run one browser action. `url` navigates first when given; otherwise acts on the current page. */
export async function browserAction(action: BrowserVerb, opts: BrowserOpts = {}): Promise<BrowserResult> {
  const { url, width = 1280, height = 800 } = opts;
  await ensureBrowser();
  const target = await resolveTarget(opts.tab);
  const cdp = await Cdp.open(target.webSocketDebuggerUrl!);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    if (url) {
      await cdp.send("Page.enable");
      // Log.enable replays whatever the page already stored, which would arrive alongside the live
      // events and show every message twice. Drop the backlog before navigating so what comes back
      // is this page load and nothing else. (Skipped when acting on an already-open page — there the
      // stored entries are the only thing there is to read.)
      await cdp.send("Log.clear").catch(() => {});
      await cdp.send("Runtime.discardConsoleEntries").catch(() => {});
      cdp.logs.length = 0;
      await cdp.send("Page.navigate", { url });
      // No Page.loadEventFired race: poll readyState, which is true whether or not we missed the event.
      for (let i = 0; i < 60; i++) {
        const r = (await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })) as { result?: { value?: string } };
        if (r.result?.value === "complete") break;
        await new Promise((res) => setTimeout(res, 250));
      }
      await new Promise((res) => setTimeout(res, 400)); // let a framework paint its first frame
      refState.delete(target.id); // navigating invalidates any refs read from the old page
    }
    const where = (await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })) as { result?: { value?: string } };
    const here = where.result?.value ?? "(unknown url)";

    // acting verbs — read builds the ref map; the rest act by ref and check staleness first
    const needRef = (): number => {
      const st = refState.get(target.id);
      if (!st) throw new Error("no refs for this tab — `read` first");
      if (st.url !== here) throw new Error("page changed since `read` — `read` again");
      const id = st.refs.get(String(opts.ref ?? ""));
      if (id === undefined) throw new Error(`unknown ref: ${String(opts.ref ?? "(none)")} — \`read\` first`);
      return id;
    };
    const domReady = async (): Promise<void> => {
      await cdp.send("DOM.enable").catch(() => {});
      await cdp.send("DOM.getDocument", { depth: 0 });
    };
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300)); // let handlers run and paint

    if (action === "read") {
      await cdp.send("Accessibility.enable").catch(() => {});
      const ax = (await cdp.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
      const { text, refs } = formatAxTree(ax.nodes ?? []);
      refState.set(target.id, { url: here, refs });
      return { text: `${here}\n\n${text || "(empty accessibility tree)"}` };
    }
    if (action === "click") {
      if (opts.x !== undefined && opts.y !== undefined) {
        // canvas/games have no DOM refs — click straight at viewport coordinates
        const x = Number(opts.x);
        const y = Number(opts.y);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        await settle();
        return { text: `clicked (${x}, ${y}) on ${here}` };
      }
      const backendNodeId = needRef();
      await domReady();
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
        throw new Error("element is not visible — `read` again");
      });
      const q = (await cdp.send("DOM.getContentQuads", { backendNodeId }).catch(() => ({}))) as { quads?: number[][] };
      const quad = q.quads?.[0];
      if (!quad || quad.length < 8) throw new Error("element is not visible — `read` again");
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await settle();
      return { text: `clicked ${opts.ref} on ${here}` };
    }
    if (action === "type") {
      const backendNodeId = needRef();
      await domReady();
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
        throw new Error("element is not visible — `read` again");
      });
      await cdp.send("DOM.focus", { backendNodeId }).catch(() => {
        throw new Error("element is not visible — `read` again");
      });
      // select existing content so insertText replaces it (selection APIs aren't trust-gated)
      await cdp.send("Runtime.evaluate", { expression: "{const e=document.activeElement; if(e&&typeof e.select==='function')e.select(); else if(e&&e.isContentEditable)document.execCommand('selectAll');}" });
      const text = String(opts.text ?? "");
      if (text) await cdp.send("Input.insertText", { text });
      else await pressKey(cdp, "backspace"); // empty text = clear the field
      return { text: `typed into ${opts.ref} on ${here}` };
    }
    if (action === "press") {
      await pressKey(cdp, String(opts.key ?? ""), Number(opts.hold) || 0);
      await settle();
      return { text: `pressed ${opts.key} on ${here}` };
    }
    if (action === "scroll") {
      if (opts.ref) {
        const backendNodeId = needRef();
        await domReady();
        await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
          throw new Error("element is not visible — `read` again");
        });
        return { text: `scrolled ${opts.ref} into view on ${here}` };
      }
      const dir = String(opts.direction ?? "down");
      const amount = Number(opts.amount) || 600;
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: dx, deltaY: dy });
      await settle();
      return { text: `scrolled ${dir} ${amount}px on ${here}` };
    }

    if (action === "screenshot") {
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
      if (!shot.data) throw new Error("the browser returned no image");
      return { text: here, screenshot: Buffer.from(shot.data, "base64") };
    }
    if (action === "console") {
      return { text: cdp.logs.length ? cdp.logs.join("\n") : `(no console output on ${here})` };
    }
    if (action === "text") {
      const r = (await cdp.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true })) as { result?: { value?: string } };
      return { text: `${here}\n\n${(r.result?.value ?? "").trim() || "(the page rendered no text)"}` };
    }
    const title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })) as { result?: { value?: string } };
    return { text: `Opened ${here} — "${title.result?.value ?? ""}"${cdp.logs.length ? `\n\nConsole:\n${cdp.logs.join("\n")}` : ""}` };
  } finally {
    cdp.close();
  }
}
