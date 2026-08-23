// Drive a real browser so the agent can look at what it just built: navigate, screenshot, read the
// rendered text, read the console — and now act on it: read the accessibility tree, then click,
// type, press keys, and scroll by ref. Speaks the Chrome DevTools Protocol directly over the debug
// port — node has fetch and WebSocket built in, so this costs no dependency (puppeteer/playwright
// would each add >100MB and a bundled browser to an app that already ships an Electron one).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Bridge, EXT_DIR, RemoteBridge, isAttachable, type BridgeLike } from "./bridge.ts";
import { resolveChromeProfile } from "./chrome-profiles.ts";
import { loadSettings } from "./settings.ts";

const PORT = Number(process.env.ADA_CDP_PORT) || 9222;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The exe the OS itself opens https:// with, when we can read it and it speaks CDP. Only Chromium
 *  browsers do — Firefox/Safari have no debug port we can drive, so they fall through to the list. */
function defaultBrowserExe(): string | null {
  const run = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  try {
    if (process.platform === "win32") {
      const choice = run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"]);
      const progId = /ProgId\s+REG_SZ\s+(\S+)/.exec(choice)?.[1];
      if (!progId) return null;
      const cmd = run("reg", ["query", `HKCR\\${progId}\\shell\\open\\command`, "/ve"]);
      const exe = /"([^"]+\.exe)"/i.exec(cmd)?.[1] ?? /(\S+\.exe)/i.exec(cmd.split("REG_SZ")[1] ?? "")?.[1];
      return exe && existsSync(exe) ? exe : null;
    }
    if (process.platform === "darwin") {
      // LaunchServices stores the bundle id; map the Chromium ones we can actually drive.
      const plist = run("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]);
      const id = /LSHandlerURLScheme = https;[\s\S]{0,200}?LSHandlerRoleAll = "?([\w.]+)/.exec(plist)?.[1]?.toLowerCase() ?? "";
      const apps: Record<string, string> = {
        "com.google.chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "com.microsoft.edgemac": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "com.brave.browser": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "org.chromium.chromium": "/Applications/Chromium.app/Contents/MacOS/Chromium",
      };
      const exe = apps[id];
      return exe && existsSync(exe) ? exe : null;
    }
    const desktop = run("xdg-settings", ["get", "default-web-browser"]).trim().toLowerCase();
    const linux: [RegExp, string[]][] = [
      [/chrome/, ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]],
      [/chromium/, ["/usr/bin/chromium", "/usr/bin/chromium-browser"]],
      [/edge/, ["/usr/bin/microsoft-edge"]],
      [/brave/, ["/usr/bin/brave-browser"]],
    ];
    for (const [re, paths] of linux) if (re.test(desktop)) return paths.find((p) => existsSync(p)) ?? null;
    return null;
  } catch {
    return null;
  }
}

/** Where Chrome/Edge usually lives, per platform. First hit wins; $ADA_BROWSER overrides, and the
 *  OS default browser is preferred over the hardcoded list when it is a Chromium we can drive. */
function browserPaths(): string[] {
  if (process.env.ADA_BROWSER) return [process.env.ADA_BROWSER];
  const preferred = defaultBrowserExe();
  const p = process.platform;
  if (preferred) return [preferred, ...fallbackPaths(p)];
  return fallbackPaths(p);
}

function fallbackPaths(p: string): string[] {
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

/** Headless only where nobody could watch anyway. Automating real sites means solving the odd
 *  captcha and seeing what went wrong, so a visible window is the default. */
function headless(): boolean {
  if (process.env.ADA_BROWSER_HEADLESS === "1") return true;
  if (process.env.ADA_BROWSER_HEADLESS === "0") return false;
  if (process.env.CI) return true;
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/** Reuse an already-running debug browser, else start one in ada's own persistent profile — so a
 *  login survives to the next run. Still not the user's real profile directory: Chrome 136+ refuses
 *  --remote-debugging-port there, and sharing it would fight with their open windows. To drive the
 *  real one, start it yourself with --remote-debugging-port and ada will attach to it. */
async function ensureBrowser(): Promise<void> {
  if (await debuggerUp()) return;
  const exe = browserPaths().find((p) => existsSync(p));
  if (!exe) throw new Error(`no Chromium-based browser found. Install Chrome/Edge, or set ADA_BROWSER to its path (or start any Chrome with --remote-debugging-port=${PORT}).`);
  const profile = process.env.ADA_BROWSER_PROFILE || join(homedir(), ".ada", "browser-profile");
  mkdirSync(profile, { recursive: true });
  // --disable-features=CalculateNativeWinOcclusion: on Windows, a window that opens behind the
  // user's other windows is reported fully occluded, and Chrome then marks the renderer hidden and
  // throttles it. Synthetic Input.* events are silently dropped on a hidden widget while the dispatch
  // still reports success, so a click "succeeded" and the page never saw a mousedown. It only looked
  // flaky because a window that later became visible stayed working for the rest of its life.
  const flags = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-features=CalculateNativeWinOcclusion", "about:blank"];
  if (headless()) flags.splice(2, 0, "--headless=new", "--disable-gpu");
  const child = spawn(exe, flags, {
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

// ---- transport: the extension bridge when it is there, the debug port otherwise ----

let bridge: BridgeLike | null = null;
let bridgeChecked = false;
/** Decided once per process. Re-deciding per action let a single run start in ada's own profile and
 *  then silently switch to the user's real browser halfway through. */
let bridgeMode: boolean | null = null;
/** When the last failed check happened. A session that started while the extension was reloading, or
 *  while another ada held the port, used to be downgraded to the scratch profile FOREVER - it never
 *  looked again, and never said so. Re-check periodically instead; success stays sticky, because
 *  switching browsers mid-session is the confusion this whole arrangement exists to avoid. */
let bridgeCheckedAt = 0;
const BRIDGE_RECHECK_MS = 60_000;

/** The saved profile choice, if any. Read lazily: settings can change between runs, and a browser
 *  action is rare enough that re-reading a small JSON file costs nothing. */
function settingsProfile(): string | undefined {
  try {
    return loadSettings(true).chromeProfile;
  } catch {
    return undefined;
  }
}

/** Is that browser already running? A running Chrome ignores --load-extension, so spawning one
 *  cannot do the job it is there for - and the `about:blank` it is handed STEALS the user's active
 *  tab. `browse` then reads that tab and reports their browser is empty, which is how ada came to
 *  answer "your browser is on a blank page" while their work sat one tab away. Measured: the active
 *  tab went from a LeetCode problem to about:blank, and a blank tab was left behind each time. */
function browserRunning(exe: string): boolean {
  const name = exe.split(/[\/]/).pop() ?? "";
  if (!name) return false;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
      return out.toLowerCase().includes(name.toLowerCase());
    }
    execFileSync("pgrep", ["-f", name], { timeout: 4000, stdio: "ignore" });
    return true;
  } catch {
    return false; // tasklist/pgrep missing, or no match - treat as not running
  }
}

/** The bridge drives the user's REAL browser (their logins, their tabs) via a loaded extension;
 *  the debug port drives ada's own profile. Prefer the bridge when the extension is actually
 *  connected, because that is the browser the user means. ADA_BROWSER_BRIDGE=0 opts out. */
async function getBridge(): Promise<BridgeLike | null> {
  if (process.env.ADA_BROWSER_BRIDGE === "0") return null;
  if (bridgeMode === true) return bridge;
  if (bridgeMode === false) {
    // Already own a listening bridge? The extension may simply have reconnected since - that costs
    // one property read, so it is worth trying on every action rather than on the slow clock.
    if (bridge?.connected) {
      bridgeMode = true;
      return bridge;
    }
    if (Date.now() - bridgeCheckedAt < BRIDGE_RECHECK_MS) return null;
    bridgeMode = null;
    bridgeChecked = false;
    bridge = null;
  }
  if (bridgeChecked) return null;
  bridgeChecked = true;
  // Strict mode: the caller means the REAL browser. Falling back to ada's own profile would run the
  // same commands against a different set of logins and look like the site had signed them out -
  // which is exactly the confusion that cost an afternoon here. Fail loudly instead.
  const strict = process.env.ADA_BROWSER_BRIDGE === "1";
  try {
    bridge = await Bridge.start();
  } catch {
    // The port is taken. If the holder is a live ada bridge, borrow it - the old behaviour was to
    // give up (or make the caller kill the holder), which turned every second run into a taskkill.
    const remote = await RemoteBridge.connect();
    if (remote) {
      bridge = remote;
      bridgeMode = remote.connected;
      bridgeCheckedAt = Date.now();
      if (!bridgeMode && strict) throw new Error("ADA_BROWSER_BRIDGE=1: borrowed another ada's bridge, but its extension is not connected.");
      return bridgeMode ? bridge : null;
    }
    bridge = null;
    bridgeMode = false;
    bridgeCheckedAt = Date.now();
    if (strict)
      throw new Error(
        "ADA_BROWSER_BRIDGE=1 but port 9223 is held by something that cannot reach the browser — " +
          "either another program owns it, or a previous ada left a bridge whose extension is gone. " +
          "Close that process (or the Chrome it was driving) and retry.",
      );
    return null;
  }
  // The extension retries every 2s, so this window is generous enough to catch a live one and short
  // enough not to punish the common case of no extension at all.
  for (let i = 0; i < 12 && !bridge.connected; i++) await new Promise((r) => setTimeout(r, 250));

  // Still nothing: the profile holding the extension is probably just not open. Start it. This is
  // the user's ordinary Chrome with their ordinary profile - no debugging flags, nothing special -
  // so the extension loads itself and dials in. Without this, "drive my browser" silently means
  // "drive a different browser" any time their window happens to be closed.
  if (!bridge.connected && process.env.ADA_BROWSER_BRIDGE !== "0") {
    const exe = browserPaths().find((p) => existsSync(p));
    const alreadyOpen = exe ? browserRunning(exe) : false;
    if (exe && !alreadyOpen) {
      // Which profile? The extension is per-profile, so launching Default when the extension lives in
      // another one drives a browser ada cannot reach. Ask where it actually is.
      const chosen = await resolveChromeProfile(EXT_DIR, settingsProfile());
      const profileDir = chosen.dir;
      if (process.env.ADA_BROWSER_DEBUG) console.error(`[bridge] profile=${profileDir} (${chosen.why})`);
      // Side-load the bridge while we're starting it anyway. Without this the extension has to be
      // installed by hand at chrome://extensions — the one page the debugger may never touch — and
      // Chrome drops unpacked extensions often enough that "it worked last month" isn't worth much.
      // Verified on Chrome 151; --load-extension alone, so their other extensions stay enabled.
      // Only bites when Chrome is CLOSED: a running instance owns the profile and ignores our flags.
      spawn(exe, [`--profile-directory=${profileDir}`, `--load-extension=${EXT_DIR}`, "about:blank"], { detached: true, stdio: "ignore" }).unref();
      for (let i = 0; i < (strict ? 120 : 40) && !bridge.connected; i++) await new Promise((r) => setTimeout(r, 250));
    }
  }
  bridgeMode = bridge.connected;
  bridgeCheckedAt = Date.now();
  if (process.env.ADA_BROWSER_DEBUG) console.error(`[bridge] own=true connected=${bridgeMode}`);
  if (!bridgeMode && strict) {
    throw new Error(
      "ADA_BROWSER_BRIDGE=1 but the ada bridge extension never connected. Open the Chrome profile it is loaded in " +
        "(extensions are per-profile), check chrome://extensions, then retry. Refusing to fall back to ada's own " +
        "profile, which has different logins.",
    );
  }
  return bridgeMode ? bridge : null;
}

/** Sites ada must not drive through the user's real session. Empty by default: the one case that
 *  looked like a site killing its session turned out to be a silent fallback to a logged-out
 *  profile, and blocking a site on that evidence would have been superstition. Set
 *  ADA_BRIDGE_BLOCKED to a comma-separated host list if a site really does punish automation. */
const BRIDGE_BLOCKED = (process.env.ADA_BRIDGE_BLOCKED ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Pure, so selfcheck can exercise the matching without a browser. */
export function bridgeBlocks(url: string, blocked: string[] = BRIDGE_BLOCKED): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return blocked.some((b) => host === b || host.endsWith(`.${b}`));
}

function assertBridgeAllowed(url: string): void {
  if (!bridgeBlocks(url)) return;
  throw new Error(`refusing to drive ${new URL(url).hostname} through your real browser (ADA_BRIDGE_BLOCKED). Use ADA_BROWSER_BRIDGE=0 to act in ada's own profile instead.`);
}

/** What browserAction needs from a transport: send a CDP method, collect console output, hang up. */
interface CdpLike {
  send(method: string, params?: Json, timeoutMs?: number): Promise<Json>;
  readonly logs: string[];
  close(): void;
}

/** CDP over the extension. chrome.debugger speaks the same protocol, so only the wire changes. */
class BridgeSession implements CdpLike {
  constructor(
    private b: BridgeLike,
    private tabId: number,
  ) {}
  get logs(): string[] {
    return this.b.logs;
  }
  async send(method: string, params: Json = {}, timeoutMs = 30_000): Promise<Json> {
    return (await this.b.cdp(this.tabId, method, params, timeoutMs)) as Json;
  }
  close(): void {
    // Deliberately stays attached: detaching per action would make Chrome's "ada bridge is debugging
    // this browser" bar flicker on and off, and every action would pay the re-attach cost.
  }
}

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
  const b = await getBridge();
  if (b) {
    // Same verbs against the real browser. Tabs the debugger cannot attach to (chrome://, the Web
    // Store) are listed but marked, so a model can see them without being tempted to act on them.
    if (action === "tabs") {
      const all = await b.tabs();
      const rows = all.map((t) => `${String(t.id)}${String(t.id) === selectedTabId ? " *" : isAttachable(t.url) ? "  " : " -"}  ${originOf(t.url)}`).join("\n");
      // Say which browser these came from: the two transports have different logins, and a silent
      // difference between them is indistinguishable from a site signing you out.
      return `[your real browser, via the ada bridge extension]\n${rows || "(no tabs)"}`;
    }
    if (action === "tab_new") {
      const made = (await b.call("newTab", { url: "about:blank" })) as { id?: number };
      selectedTabId = made.id === undefined ? null : String(made.id);
      return `opened tab ${selectedTabId}`;
    }
    if (!tab) throw new Error(`${action} needs a tab id — list with \`tabs\``);
    const known = (await b.tabs()).find((t) => String(t.id) === tab);
    if (!known) throw new Error(`no such tab: ${tab} — list with \`tabs\``);
    if (action === "tab_select") {
      if (!isAttachable(known.url)) throw new Error(`cannot drive ${originOf(known.url)} — Chrome blocks the debugger on its own pages`);
      await b.call("activate", { tabId: known.id });
      selectedTabId = tab;
      return `selected tab ${tab}`;
    }
    await b.call("closeTab", { tabId: known.id });
    refState.delete(tab);
    if (selectedTabId === tab) selectedTabId = null;
    return `closed tab ${tab}`;
  }
  await ensureBrowser();
  if (action === "tabs") {
    const pages = await listPages();
    const rows = pages.map((p) => `${p.id}${p.id === selectedTabId ? " *" : ""}  ${originOf(p.url)}`).join("\n");
    return `[ada's own browser profile - not your logged-in Chrome]\n${rows || "(no tabs)"}`;
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

  send(method: string, params: Json = {}, timeoutMs = 30_000): Promise<Json> {
    const id = ++this.id;
    return new Promise<Json>((ok, fail) => {
      this.waiters.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiters.delete(id)) fail(new Error(`${method} timed out`));
      }, timeoutMs);
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
async function pressKey(cdp: { send(method: string, params?: Json): Promise<Json> }, name: string, hold = 0): Promise<void> {
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
  pdf?: Buffer;
}

export type BrowserVerb =
  | "open"
  | "screenshot"
  | "text"
  | "console"
  | "read"
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "wait"
  | "select"
  | "hover"
  | "fill"
  | "upload"
  | "eval"
  | "drag"
  | "back"
  | "forward"
  | "reload"
  | "pdf";

export interface BrowserOpts {
  url?: string;
  width?: number;
  height?: number;
  tab?: string;
  ref?: string;
  selector?: string;
  find?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  hold?: number;
  text?: string;
  value?: string;
  fields?: Record<string, string>;
  files?: string[];
  expression?: string;
  timeout?: number;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

/** Find one element by CSS selector, or by the visible text a human would click. Serialized into the
 *  page because CDP's DOM.querySelector can't match text and won't see into shadow-free innerText. */
const FINDER = `(sel, txt) => {
  if (sel) return document.querySelector(sel);
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const want = norm(txt);
  if (!want) return null;
  const seen = (el) => { const r = el.getBoundingClientRect(); return !!(r.width || r.height); };
  const label = (el) => norm(el.getAttribute("aria-label") || el.value || el.placeholder || el.innerText || el.textContent);
  const inter = [...document.querySelectorAll('a,button,input,select,textarea,summary,[contenteditable],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"]')].filter(seen);
  const exact = inter.find((el) => label(el) === want);
  if (exact) return exact;
  const partial = inter.find((el) => label(el).includes(want));
  if (partial) return partial;
  const deep = [...document.querySelectorAll("body *")].filter((el) => seen(el) && norm(el.innerText).includes(want) && ![...el.children].some((c) => norm(c.innerText).includes(want)));
  return deep[0] || null;
}`;

/** Pick a transport and a tab: the real browser through the extension, else ada's own profile. */
async function openSession(tab?: string): Promise<{ cdp: CdpLike; tabKey: string }> {
  const b = await getBridge();
  if (b) {
    const usable = await b.targets();
    let picked = tab ? usable.find((t) => String(t.id) === tab) : usable.find((t) => String(t.id) === selectedTabId);
    if (tab && !picked) throw new Error(`no such tab: ${tab} - list with \`tabs\``);
    picked ??= usable[0];
    if (!picked) {
      const made = (await b.call("newTab", { url: "about:blank" })) as { id?: number };
      if (made.id === undefined) throw new Error("could not open a tab in the browser");
      picked = { id: made.id, url: "about:blank", title: "", active: true };
    }
    const session = new BridgeSession(b, picked.id);
    // Without these the page sends no console or exception events for the `console` verb to show.
    await session.send("Runtime.enable").catch(() => {});
    await session.send("Log.enable").catch(() => {});
    return { cdp: session, tabKey: String(picked.id) };
  }
  await ensureBrowser();
  const target = await resolveTarget(tab);
  return { cdp: await Cdp.open(target.webSocketDebuggerUrl!), tabKey: target.id };
}

/** The verbs a content script can serve. Everything here avoids chrome.debugger entirely: no
 *  "ada bridge started debugging this browser" banner, and one message instead of a protocol
 *  handshake plus several round trips. Anything needing real input events still goes through CDP. */
const DOM_ABLE = new Set<BrowserVerb>(["read", "text", "click", "type", "screenshot", "open"]);

/** Serve an action from the page itself. Returns null when this action needs the debugger after all
 *  (a coordinate click, for instance, has no element to talk to). */
async function viaContentScript(b: BridgeLike, action: BrowserVerb, opts: BrowserOpts): Promise<BrowserResult | null> {
  const usable = await b.targets();
  const picked = opts.tab ? usable.find((t) => String(t.id) === opts.tab) : (usable.find((t) => String(t.id) === selectedTabId) ?? usable[0]);
  if (!picked) return null;
  const tabId = picked.id;

  if (opts.url) {
    await b.call("navigate", { tabId, url: opts.url });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const t = (await b.tabs()).find((x) => x.id === tabId);
      if (t && t.url && !/^about:/.test(t.url)) break;
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  if (action === "open") {
    const t = (await b.tabs()).find((x) => x.id === tabId);
    return { text: `Opened ${t?.url ?? "(unknown)"} — "${t?.title ?? ""}"` };
  }
  if (action === "screenshot") {
    const r = (await b.call("shot", { tabId })) as { dataUrl?: string };
    const data = r.dataUrl?.split(",")[1];
    if (!data) return null; // fall through to CDP rather than pretend
    const t = (await b.tabs()).find((x) => x.id === tabId);
    return { text: t?.url ?? "(unknown)", screenshot: Buffer.from(data, "base64") };
  }
  if (action === "text") {
    const r = (await b.call("dom", { tabId, action: "text" })) as { text?: string; url?: string };
    return { text: `${r.url ?? ""}\n\n${(r.text ?? "").trim() || "(the page rendered no text)"}` };
  }
  if (action === "read") {
    // The CDP path answers `read` with the full accessibility tree, which carries the page's static
    // text as well as its controls. A snapshot lists only interactive elements, so `click` then
    // `read` to confirm the result showed nothing had changed — the same verb answering differently
    // depending on which transport happened to be live, which is indistinguishable from the click
    // having failed. Ask for the text too; both round trips are local and cost single-digit ms.
    const [snap, body] = (await Promise.all([
      b.call("dom", { tabId, action: "snapshot" }),
      b.call("dom", { tabId, action: "text" }),
    ])) as [{ url?: string; tree?: string; count?: number }, { text?: string }];
    const text = (body.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return {
      text: `${snap.url ?? ""}\n\n${snap.tree || "(nothing interactive on this page)"}${text ? `\n\n--- page text ---\n${text}` : ""}`,
    };
  }
  if (action === "click") {
    if (opts.x !== undefined && opts.y !== undefined) return null; // coordinates need real input
    const r = (await b.call("dom", { tabId, action: "click", arg: { ref: opts.ref, selector: opts.selector, find: opts.find } })) as { clicked?: string; url?: string };
    return { text: `clicked ${r.clicked ?? opts.ref ?? opts.selector ?? opts.find} on ${r.url ?? ""}` };
  }
  if (action === "type") {
    const r = (await b.call("dom", { tabId, action: "type", arg: { ref: opts.ref, selector: opts.selector, find: opts.find, text: opts.text ?? "" } })) as { into?: string };
    return { text: `typed into ${r.into ?? opts.ref ?? opts.selector ?? opts.find}` };
  }
  return null;
}

/** Which browser the action actually ran in. Falling back to ada's own profile is invisible
 *  otherwise: it answers about a browser the user has never seen, with their tabs and logins
 *  absent, and sounds equally confident either way. Someone watching ada describe "your open
 *  tab" while it reads a scratch profile has no way to tell. So say it in the text the model
 *  reads - a note it can pass on beats a silence nobody notices. ~20 tokens, and only while the
 *  fallback is in force; ADA_BROWSER_BRIDGE=0 is a deliberate opt-out and stays quiet. */
const SCRATCH_NOTE =
  "[ada's own browser - NOT the user's Chrome: their tabs, logins and sessions are not here. Say so before calling anything on this page theirs.]";

export async function browserAction(action: BrowserVerb, opts: BrowserOpts = {}): Promise<BrowserResult> {
  const r = await browserActionInner(action, opts);
  if (bridgeMode === false && process.env.ADA_BROWSER_BRIDGE !== "0") return { ...r, text: `${SCRATCH_NOTE}
${r.text}` };
  return r;
}

/** Run one browser action. `url` navigates first when given; otherwise acts on the current page. */
async function browserActionInner(action: BrowserVerb, opts: BrowserOpts = {}): Promise<BrowserResult> {
  const { url, width = 1280, height = 800 } = opts;
  if (url && bridgeMode) assertBridgeAllowed(url);

  // Prefer the page over the protocol when the bridge is live and the verb allows it.
  if (DOM_ABLE.has(action) && process.env.ADA_BROWSER_CONTENT !== "0") {
    const b = await getBridge();
    if (b) {
      try {
        const done = await viaContentScript(b, action, opts);
        if (done) return done;
      } catch (e) {
        // A page that refuses injection (the Web Store, a PDF viewer) is a reason to fall back,
        // not to fail the whole action.
        if (process.env.ADA_BROWSER_DEBUG) console.error(`content script: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const { cdp, tabKey } = await openSession(opts.tab);
  const target = { id: tabKey };
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
      // Page.navigate does not always acknowledge: heavy anti-bot pages (and any page that opens a
      // JS dialog) leave the command hanging even though the navigation itself commits fine. The
      // readyState poll below is the real completion signal, so a missing ack is not an error.
      await cdp.send("Page.navigate", { url }, 10_000).catch(() => {});
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
    // Also guard the page we happen to have landed on - a redirect, or an already-open tab, can put
    // us on a blocked site without any blocked URL ever being passed in.
    if (bridgeMode) assertBridgeAllowed(here);

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

    /** The node this action targets: an explicit ref, else a CSS selector, else visible text. */
    const nodeFor = async (): Promise<number> => {
      if (opts.ref) return needRef();
      if (!opts.selector && !opts.find) throw new Error("need `ref` (from `read`), `selector`, or `find`");
      const r = (await cdp.send("Runtime.evaluate", {
        expression: `(${FINDER})(${JSON.stringify(opts.selector ?? null)}, ${JSON.stringify(opts.find ?? null)})`,
      })) as { result?: { objectId?: string } };
      const objectId = r.result?.objectId;
      if (!objectId) throw new Error(`nothing matched ${opts.selector ? `selector ${opts.selector}` : `text "${opts.find}"`} on ${here}`);
      const d = (await cdp.send("DOM.describeNode", { objectId })) as { node?: { backendNodeId?: number } };
      const id = d.node?.backendNodeId;
      if (id === undefined) throw new Error("matched something that is not an element");
      return id;
    };
    const centerOf = async (backendNodeId: number): Promise<{ x: number; y: number }> => {
      await domReady();
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
        throw new Error("element is not visible");
      });
      const q = (await cdp.send("DOM.getContentQuads", { backendNodeId }).catch(() => ({}))) as { quads?: number[][] };
      const quad = q.quads?.[0];
      if (!quad || quad.length < 8) throw new Error("element is not visible");
      return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
    };

    /** Dispatch a click on the element ITSELF, not at a point in space. Needed when something else
     *  sits on top of the target: the synthetic click then lands on the overlay, the page receives a
     *  perfectly trusted event, and nothing happens - which reads exactly like a broken click. */
    const domClick = async (backendNodeId: number): Promise<void> => {
      const r = (await cdp.send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
      const objectId = r.object?.objectId;
      if (!objectId) throw new Error("could not reach that element to click it");
      await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ this.click(); }", awaitPromise: true });
    };

    /** Is the target actually the topmost thing at its own centre? */
    const isOnTop = async (backendNodeId: number, x: number, y: number): Promise<boolean> => {
      const r = (await cdp.send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
      const objectId = r.object?.objectId;
      if (!objectId) return true;
      const res = (await cdp.send("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function(x, y){ const top = document.elementFromPoint(x, y); return !!top && (top === this || this.contains(top) || top.contains(this)); }`,
        arguments: [{ value: x }, { value: y }],
      })) as { result?: { value?: boolean } };
      return res.result?.value !== false;
    };
    const evalJs = async (expression: string): Promise<unknown> => {
      const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
        result?: { value?: unknown };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "script threw");
      return r.result?.value;
    };
    const settleLoad = async (): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        if ((await evalJs("document.readyState")) === "complete") break;
        await new Promise((res) => setTimeout(res, 250));
      }
      refState.delete(target.id);
      await new Promise((res) => setTimeout(res, 400));
    };

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
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
        await settle();
        return { text: `clicked (${x}, ${y}) on ${here}` };
      }
      const backendNodeId = await nodeFor();
      const { x, y } = await centerOf(backendNodeId);
      const target = String(opts.ref ?? opts.selector ?? opts.find);
      if (!(await isOnTop(backendNodeId, x, y))) {
        // Covered by something. A real mouse could not reach it either, so stop pretending to be one.
        await domClick(backendNodeId);
        await settle();
        return { text: `clicked ${target} on ${here} (element was covered - dispatched on the element itself)` };
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      await settle();
      return { text: `clicked ${target} on ${here}` };
    }
    if (action === "type") {
      const backendNodeId = await nodeFor();
      await centerOf(backendNodeId);
      await cdp.send("DOM.focus", { backendNodeId }).catch(() => {
        throw new Error("element is not visible — `read` again");
      });
      // select existing content so insertText replaces it (selection APIs aren't trust-gated)
      await cdp.send("Runtime.evaluate", { expression: "{const e=document.activeElement; if(e&&typeof e.select==='function')e.select(); else if(e&&e.isContentEditable)document.execCommand('selectAll');}" });
      const text = String(opts.text ?? "");
      if (text) await cdp.send("Input.insertText", { text });
      else await pressKey(cdp, "backspace"); // empty text = clear the field
      return { text: `typed into ${opts.ref ?? opts.selector ?? opts.find} on ${here}` };
    }
    if (action === "press") {
      await pressKey(cdp, String(opts.key ?? ""), Number(opts.hold) || 0);
      await settle();
      return { text: `pressed ${opts.key} on ${here}` };
    }
    if (action === "scroll") {
      if (opts.ref || opts.selector || opts.find) {
        await centerOf(await nodeFor());
        return { text: `scrolled ${opts.ref ?? opts.selector ?? opts.find} into view on ${here}` };
      }
      const dir = String(opts.direction ?? "down");
      const amount = Number(opts.amount) || 600;
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: dx, deltaY: dy });
      await settle();
      return { text: `scrolled ${dir} ${amount}px on ${here}` };
    }

    if (action === "hover") {
      const { x, y } = await centerOf(await nodeFor());
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await settle();
      return { text: `hovered ${opts.ref ?? opts.selector ?? opts.find} on ${here}` };
    }
    if (action === "drag") {
      const from = opts.x !== undefined && opts.y !== undefined ? { x: Number(opts.x), y: Number(opts.y) } : await centerOf(await nodeFor());
      const toX = Number(opts.toX);
      const toY = Number(opts.toY);
      if (!Number.isFinite(toX) || !Number.isFinite(toY)) throw new Error("drag needs toX and toY");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        // HTML5 drag handlers ignore a single teleporting move — walk it like a hand would
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((toX - from.x) * i) / 10, y: from.y + ((toY - from.y) * i) / 10, button: "left" });
        await new Promise((r) => setTimeout(r, 20));
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1 });
      await settle();
      return { text: `dragged to (${toX}, ${toY}) on ${here}` };
    }
    if (action === "select") {
      const backendNodeId = await nodeFor();
      const r = (await cdp.send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
      const objectId = r.object?.objectId;
      if (!objectId) throw new Error("could not reach that element");
      const want = String(opts.value ?? opts.text ?? "");
      const res = (await cdp.send("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function (want) {
          if (this.tagName !== "SELECT") throw new Error("not a <select>");
          const opt = [...this.options].find((o) => o.value === want) || [...this.options].find((o) => o.textContent.trim() === want) || [...this.options].find((o) => o.textContent.trim().toLowerCase().includes(want.toLowerCase()));
          if (!opt) throw new Error("no option matching " + JSON.stringify(want) + " — have: " + [...this.options].map((o) => o.textContent.trim()).join(", "));
          this.value = opt.value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return opt.textContent.trim();
        }`,
        arguments: [{ value: want }],
      })) as { result?: { value?: string }; exceptionDetails?: { exception?: { description?: string } } };
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "select failed");
      await settle();
      return { text: `selected "${res.result?.value ?? want}" on ${here}` };
    }
    if (action === "fill") {
      const fields = opts.fields ?? {};
      const names = Object.keys(fields);
      if (!names.length) throw new Error("fill needs `fields`: a map of CSS selector → value");
      // React and friends listen to the native setter, so assigning .value directly is ignored
      // unless we go through the prototype descriptor and then fire the events they expect.
      const done = (await evalJs(`(() => {
        const fields = ${JSON.stringify(fields)};
        const out = [];
        for (const [sel, val] of Object.entries(fields)) {
          const el = document.querySelector(sel);
          if (!el) { out.push(sel + ": NOT FOUND"); continue; }
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (el.type === "checkbox" || el.type === "radio") el.checked = val === true || val === "true" || val === "on";
          else if (setter) setter.call(el, String(val));
          else el.textContent = String(val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          out.push(sel + ": ok");
        }
        return out.join("\\n");
      })()`)) as string;
      await settle();
      return { text: `filled ${names.length} field(s) on ${here}\n${done}` };
    }
    if (action === "upload") {
      const files = (opts.files ?? []).map((f) => resolve(f));
      if (!files.length) throw new Error("upload needs `files`: absolute paths to attach");
      const missing = files.filter((f) => !existsSync(f));
      if (missing.length) throw new Error(`no such file: ${missing.join(", ")}`);
      const backendNodeId = await nodeFor();
      await domReady();
      await cdp.send("DOM.setFileInputFiles", { backendNodeId, files });
      await settle();
      return { text: `attached ${files.length} file(s) on ${here}` };
    }
    if (action === "eval") {
      const expression = String(opts.expression ?? "");
      if (!expression) throw new Error("eval needs `expression`");
      const value = await evalJs(expression);
      return { text: `${here}\n\n${value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2)}` };
    }
    if (action === "wait") {
      const timeout = Math.min(Math.max(Number(opts.timeout) || 10_000, 100), 60_000);
      const started = Date.now();
      const probe = opts.selector
        ? `!!document.querySelector(${JSON.stringify(opts.selector)})`
        : opts.find
          ? `(document.body ? document.body.innerText : "").toLowerCase().includes(${JSON.stringify(String(opts.find).toLowerCase())})`
          : `document.readyState === "complete"`;
      while (Date.now() - started < timeout) {
        if ((await evalJs(probe)) === true) {
          refState.delete(target.id); // whatever we waited for probably repainted the page
          return { text: `found ${opts.selector ?? opts.find ?? "a loaded page"} after ${Date.now() - started}ms on ${here}` };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`timed out after ${timeout}ms waiting for ${opts.selector ?? opts.find ?? "load"} on ${here}`);
    }
    if (action === "back" || action === "forward") {
      const h = (await cdp.send("Page.getNavigationHistory")) as { currentIndex?: number; entries?: { id: number }[] };
      const idx = (h.currentIndex ?? 0) + (action === "back" ? -1 : 1);
      const entry = h.entries?.[idx];
      if (!entry) throw new Error(`nothing to go ${action} to`);
      await cdp.send("Page.enable");
      await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await settleLoad();
      return { text: `went ${action} — now at ${await evalJs("location.href")}` };
    }
    if (action === "reload") {
      await cdp.send("Page.enable");
      await cdp.send("Page.reload");
      await settleLoad();
      return { text: `reloaded ${here}` };
    }
    if (action === "pdf") {
      const out = (await cdp.send("Page.printToPDF", { printBackground: true })) as { data?: string };
      if (!out.data) throw new Error("the browser returned no PDF");
      return { text: here, pdf: Buffer.from(out.data, "base64") };
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
