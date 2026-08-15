// ada's half of the browser extension bridge.
//
// The extension long-polls GET /poll for one command, runs it against chrome.debugger, and POSTs the
// answer to /result. That direction matters: ada never dials into the browser, so no inbound port is
// exposed, and the whole thing is plain node:http — no websocket dependency, matching the rest of
// the browser code.
//
// This is the only way to drive the browser the user is already signed into. Verified on Chrome 151:
// --remote-debugging-port and --remote-debugging-pipe both refuse the default profile directory, and
// copying a profile loses every app-bound (v20) cookie.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.ADA_BRIDGE_PORT) || 9223;
/** Where the extension reads the shared secret from: written into the unpacked extension folder. */
const EXT_DIR = join(import.meta.dirname, "../../extension");

export interface BridgeTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

/** Chrome refuses chrome.debugger on its own pages and on the Web Store - attaching there fails with
 *  "Cannot access a chrome:// URL". Filter them out rather than offering targets that can never work. */
export function isAttachable(url: string | undefined): boolean {
  if (!url) return false;
  return !/^(chrome|edge|devtools|chrome-extension|about|view-source):/i.test(url) && !/^https:\/\/chromewebstore\.google\.com/i.test(url);
}

interface Pending {
  id: number;
  ok: (v: unknown) => void;
  fail: (e: Error) => void;
}

/** One stable secret, reused across runs. A fresh token per run would silently stop matching the
 *  copy Chrome already loaded, and the extension would just look broken. */
function stableToken(): string {
  const store = join(homedir(), ".ada", "bridge-token");
  if (existsSync(store)) {
    const t = readFileSync(store, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString("hex");
  mkdirSync(join(homedir(), ".ada"), { recursive: true });
  writeFileSync(store, t);
  return t;
}

export class Bridge {
  private server: Server;
  private token = stableToken();
  private queue: Record<string, unknown>[] = [];
  private waitingPoll: ((cmd: Record<string, unknown> | null) => void) | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private seenExtension = false;
  readonly logs: string[] = [];

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<Bridge> {
    let self: Bridge;
    const server = createServer((req, res) => self.handle(req, res));
    self = new Bridge(server);
    // The token lives beside background.js so the extension can fetch it with getURL - no copy/paste
    // ceremony for the user. It is readable by anything running as this user, which is the same
    // trust boundary as the extension folder itself.
    mkdirSync(EXT_DIR, { recursive: true });
    writeFileSync(join(EXT_DIR, "token.txt"), self.token);
    // listen() reports failure by emitting "error", not by throwing - without this handler an
    // already-taken port becomes an uncaught exception that kills the whole process.
    await new Promise<void>((ok, fail) => {
      const onError = (e: Error): void => fail(e);
      server.once("error", onError);
      server.listen(PORT, "127.0.0.1", () => {
        server.off("error", onError);
        ok();
      });
    });
    return self;
  }

  /** True once the extension has actually polled us - i.e. the browser half is alive. */
  get connected(): boolean {
    return this.seenExtension;
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/poll") {
      if (url.searchParams.get("token") !== this.token) return send(403, { error: "bad token" });
      this.seenExtension = true;
      const next = this.queue.shift();
      if (next) return send(200, next);
      // Hold the request open until there is work, or long enough to prove we are still here.
      const timer = setTimeout(() => {
        if (this.waitingPoll) {
          this.waitingPoll = null;
          send(200, {});
        }
      }, 25_000);
      this.waitingPoll = (cmd) => {
        clearTimeout(timer);
        send(200, cmd ?? {});
      };
      return;
    }

    if (url.pathname === "/result" || url.pathname === "/event") {
      void this.body(req).then((b) => {
        if (b.token !== this.token) return send(403, { error: "bad token" });
        if (url.pathname === "/event") {
          const method = String(b.method ?? "");
          const p = (b.params ?? {}) as { type?: string; args?: { value?: unknown; description?: string }[]; exceptionDetails?: { exception?: { description?: string }; text?: string } };
          if (method === "Runtime.consoleAPICalled") {
            this.logs.push(`[${p.type ?? "log"}] ${(p.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ")}`);
          } else if (method === "Runtime.exceptionThrown") {
            this.logs.push(`[error] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "uncaught exception"}`);
          }
          return send(200, { ok: true });
        }
        const w = this.pending.get(Number(b.id));
        this.pending.delete(Number(b.id));
        // Settling a waiter must never throw into this request handler: a rejected command is the
        // caller's problem to report, not a reason to take the bridge (or the process) down.
        if (w) {
          try {
            if (b.error) w.fail(new Error(String(b.error)));
            else w.ok(b.result);
          } catch {
            /* the caller already went away */
          }
        }
        send(200, { ok: true });
      });
      return;
    }

    send(404, { error: "not found" });
  }

  /** Queue one command for the extension and wait for its answer. */
  call(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const cmd = { id, op, ...params };
    return new Promise((ok, fail) => {
      this.pending.set(id, { id, ok, fail });
      setTimeout(() => {
        if (this.pending.delete(id)) fail(new Error(`bridge: ${op} timed out - is the ada bridge extension loaded and enabled?`));
      }, timeoutMs);
      if (this.waitingPoll) {
        const w = this.waitingPoll;
        this.waitingPoll = null;
        w(cmd);
      } else {
        this.queue.push(cmd);
      }
    });
  }

  /** Send one CDP method to a tab - the same protocol browser.ts already speaks. */
  cdp(tabId: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return this.call("cdp", { tabId, method, params }, timeoutMs) as Promise<Record<string, unknown>>;
  }

  async tabs(): Promise<BridgeTab[]> {
    return (await this.call("tabs")) as BridgeTab[];
  }

  /** Tabs the debugger can actually attach to, best target first (active, then most recent). */
  async targets(): Promise<BridgeTab[]> {
    const all = await this.tabs();
    const usable = all.filter((t) => isAttachable(t.url));
    return usable.sort((a, b) => Number(b.active) - Number(a.active));
  }

  close(): void {
    this.server.close();
  }

  get extensionDir(): string {
    return EXT_DIR;
  }
}
