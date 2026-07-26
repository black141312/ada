// Drive a real browser so the agent can look at what it just built: navigate, screenshot, read the
// rendered text, read the console. Speaks the Chrome DevTools Protocol directly over the debug port
// — node has fetch and WebSocket built in, so this costs no dependency (puppeteer/playwright would
// each add >100MB and a bundled browser to an app that already ships an Electron one).
//
// ponytail: one page, no tabs, no input events. Enough to answer "does it render and is the console
// clean?", which is the question that actually blocks a UI change. Add clicks when a task needs them.

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

async function pageTarget(): Promise<Target> {
  const list = (await (await fetch(`${ORIGIN}/json/list`)).json()) as Target[];
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (page) return page;
  const made = (await (await fetch(`${ORIGIN}/json/new?about:blank`, { method: "PUT" })).json()) as Target;
  if (!made.webSocketDebuggerUrl) throw new Error("could not open a page target");
  return made;
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

export interface BrowserResult {
  text: string;
  screenshot?: Buffer;
}

/** Run one browser action. `url` navigates first when given; otherwise acts on the current page. */
export async function browserAction(action: "open" | "screenshot" | "text" | "console", url?: string, width = 1280, height = 800): Promise<BrowserResult> {
  await ensureBrowser();
  const target = await pageTarget();
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
    }
    const where = (await cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })) as { result?: { value?: string } };
    const here = where.result?.value ?? "(unknown url)";

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
