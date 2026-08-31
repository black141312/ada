// Minimal MCP client (stdio, JSON-RPC 2.0). Reads ~/.ada/mcp.json — connectors are GLOBAL to the
// install, not per project — spawns each server, lists its
// tools, and registers them as ada tools (prefixed `<server>__<tool>`, gated behind approval).
// Config: { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { registerTool } from "./tools.ts";
import { registerGoogleRestTools } from "./google-rest.ts";
import { registerSocialTools } from "./social-rest.ts";
import { scrubbedEnv } from "./secret-env.ts";
import { backendHasProvider, beginLogin, clearAuth, getAuth, validAccessToken } from "./mcp-oauth.ts";

interface RpcClient {
  call(method: string, params?: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
}

function makeClient(proc: ChildProcess): RpcClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let buf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
          else p.resolve(msg.result ?? {});
        }
      } catch {
        /* servers sometimes log non-JSON to stdout — ignore */
      }
    }
  });
  const send = (obj: unknown): void => void proc.stdin?.write(`${JSON.stringify(obj)}\n`);
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
  };
}

// Streamable-HTTP MCP client: POST JSON-RPC, read a JSON or SSE response.
// ponytail: request/response only — no server-initiated notifications, no stream resumability.
/** Servers that answered 401 this run — surfaced in the UI as "needs sign-in" rather than "failed". */
const needsAuth = new Map<string, string | null>(); // name -> WWW-Authenticate header

export function authNeeded(): Record<string, string | null> {
  return Object.fromEntries(needsAuth);
}

function makeHttpClient(url: string, headers: Record<string, string>, bearer?: string): RpcClient {
  let nextId = 1;
  let sessionId: string | undefined;
  const post = (body: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        // An explicit header in the config wins: someone who pasted a token meant it.
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const take = (msg: { result?: Record<string, unknown>; error?: { message?: string } }): Record<string, unknown> => {
    if (msg.error) throw new Error(msg.error.message ?? "rpc error");
    return msg.result ?? {};
  };
  const readResult = async (res: Response, id: number): Promise<Record<string, unknown>> => {
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return take((await res.json()) as Parameters<typeof take>[0]);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let data = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.startsWith("data:")) {
          data += line.slice(5).replace(/^ /, "");
        } else if (line === "" && data) {
          let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } } | undefined;
          try {
            msg = JSON.parse(data) as typeof msg;
          } catch {
            msg = undefined;
          }
          data = "";
          if (msg && msg.id === id) {
            await reader.cancel();
            return take(msg);
          }
        }
      }
    }
    throw new Error("stream ended without a matching response");
  };
  return {
    async call(method, params) {
      const id = nextId++;
      const res = await post({ jsonrpc: "2.0", id, method, params });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return readResult(res, id);
    },
    notify(method, params) {
      void post({ jsonrpc: "2.0", method, params }).catch(() => {});
    },
  };
}

interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // remote MCP server (Streamable HTTP) instead of a local stdio command
  headers?: Record<string, string>;
  // For servers that will not register a client themselves — Google's own Calendar MCP server is
  // the reason this exists — the client id, and the scopes they insist on being asked for.
  //
  // ID ONLY, deliberately. The client id is public (it is in every consent URL); the SECRET is not,
  // and it belongs to Ada rather than to the person running this copy. It lives in the backend's
  // environment and is spent there by /v1/mcp/oauth/exchange, so shipping it — or letting it be
  // written into a user's .ada/mcp.json — would hand Ada's identity to anyone who read the file.
  oauth?: { client_id: string };
  scopes?: string[];
  // Which provider this connector authenticates against, so the backend can be asked whether it
  // already signs users in to it — the difference between a Sign in button and a setup form.
  oauthProvider?: string;
  // Tools come from Ada rather than from an MCP server at `url`. `url` still identifies the token,
  // so the sign-in flow is untouched — only where the tools come from changes.
  rest?: "gmail" | "calendar" | "x" | "linkedin";
  // Endpoints for a provider that is NOT an MCP server and therefore cannot be discovered: no 401
  // with WWW-Authenticate, no RFC 8414 metadata document, just a documented pair of URLs. Present
  // only for those; everything else still goes through discovery, which is the safer default
  // because it cannot be pointed at an endpoint by a config file.
  oauthEndpoints?: { authorization_endpoint: string; token_endpoint: string };
}

/**
 * Ask a remote server whether the credentials we hold are enough.
 *
 * A cheap `initialize` rather than a bare GET: MCP endpoints commonly reject GET outright, so a
 * GET's 405 would say nothing about authorization. A configured Authorization header short-circuits
 * this — someone who pasted a token is not asking Ada to run an OAuth flow.
 */
async function probeAuth(
  url: string,
  headers: Record<string, string>,
): Promise<{ unauthorized: boolean; wwwAuthenticate: string | null; token: string | null }> {
  // A NON-EMPTY header short-circuits this. Checking only for the key's presence treated an
  // unfilled `Authorization: ""` placeholder as "already authenticated", so a connector waiting for
  // its token reported itself as fine and then failed on the first real call.
  if (Object.entries(headers).some(([h, v]) => h.toLowerCase() === "authorization" && String(v ?? "").trim()))
    return { unauthorized: false, wwwAuthenticate: null, token: null };
  const token = await validAccessToken(url);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ada", version: "0.0.1" } } }),
    });
    if (r.status === 401 || r.status === 403) return { unauthorized: true, wwwAuthenticate: r.headers.get("www-authenticate"), token: null };
    return { unauthorized: false, wwwAuthenticate: null, token };
  } catch {
    // Unreachable is not unauthorized — let the normal connect path report it.
    return { unauthorized: false, wwwAuthenticate: null, token };
  }
}

/**
 * MCP servers this process started, so they die with it.
 *
 * A stdio connector is a long-lived child that never exits on its own. Nothing reaped them, so
 * every serve that ended — a restart after a config change, a crash, the IDE quitting — left its
 * connectors running. They accumulate silently: each one is an idle `npx` holding a node process.
 *
 * The IDE also kills the whole tree from its side; this covers `ada serve` run on its own, and
 * makes a polite shutdown clean rather than relying on the parent to sweep up.
 */
const mcpChildren = new Set<ChildProcess>();
let reaperInstalled = false;

function trackMcpChild(proc: ChildProcess): void {
  mcpChildren.add(proc);
  proc.once("exit", () => mcpChildren.delete(proc));
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = (): void => {
    for (const p of mcpChildren) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }
    mcpChildren.clear();
  };
  process.once("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      reap();
      process.exit(0);
    });
}

/** Reject rather than wait forever: one unresponsive connector must not strand the rest. */
function withTimeout<T>(name: string, p: Promise<T>, ms = 90_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`mcp ${name}: no response after ${Math.round(ms / 1000)}s — skipped`)), ms).unref?.(),
    ),
  ]);
}

export async function loadMcpServers(includeProject: boolean): Promise<string[]> {
  if (!includeProject) return []; // MCP servers run code — trusted projects only
  // Plugin-provided servers first, then .ada/mcp.json — so the project file wins on name collision.
  const servers: Record<string, McpServerDef> = {};
  const readServers = (p: string): void => {
    if (!existsSync(p)) return;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as { servers?: Record<string, McpServerDef> };
      Object.assign(servers, cfg.servers ?? {});
    } catch {
      /* bad json — skip */
    }
  };
  const pluginRoot = resolve(process.cwd(), ".ada", "plugins");
  try {
    for (const plugin of readdirSync(pluginRoot)) readServers(resolve(pluginRoot, plugin, "mcp.json"));
  } catch {
    /* no plugins dir */
  }
  // The SAME file the connectors screen writes. This used to hardcode `./.ada/mcp.json` while the
  // rest of this module went through configPath(), so making connectors global fixed the UI and
  // left the agent still loading per-project: a connector could be listed, signed in, and simply
  // not present in the turn. Plugins above stay project-local — those are installed into the repo.
  ensureConfigMigrated();
  readServers(configPath());
  // Refresh the STRUCTURAL fields of catalog connectors from the catalog.
  //
  // `addConnector` copies the catalog entry into the config, so a connector added last month is
  // frozen as the catalog was then. Changing where a connector's tools come from, or which scopes
  // it asks for, reached only people who had not connected it yet — everyone else silently kept the
  // old definition. That is how `rest` looked like it did nothing: the catalog had it, the saved
  // config did not, and the config wins.
  //
  // Only fields Ada owns are refreshed. `oauth.client_id`, `env` and `headers` are the user's and
  // are left exactly as they are.
  for (const [name, def] of Object.entries(servers)) {
    const cat = CATALOG[name]?.server;
    if (!cat) continue;
    servers[name] = { ...def, url: cat.url ?? def.url, scopes: cat.scopes ?? def.scopes, oauthProvider: cat.oauthProvider ?? def.oauthProvider, rest: cat.rest, oauthEndpoints: cat.oauthEndpoints };
  }
  const loaded: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    try {
      let rpc: RpcClient;
      // A connector whose tools are built in rather than fetched from an MCP server. It still signs
      // in exactly like a remote one — same OAuth flow, same token store, `url` is its identity —
      // but its tools call the service's ordinary REST API. Google's Gmail and Calendar MCP servers
      // are gated behind a Developer Preview; their REST APIs are not, and answer the same token.
      if (def.rest) {
        const token = await validAccessToken(def.url ?? "");
        if (!token) {
          needsAuth.set(name, null); // shows as "needs sign-in", the same as a 401 from a remote
          console.error(`mcp ${name}: needs sign-in`);
          continue;
        }
        needsAuth.delete(name);
        // Resolved per call, not captured: a token refreshed mid-session must be the one used.
        const n =
          def.rest === "x" || def.rest === "linkedin"
            ? registerSocialTools(name, def.rest, () => validAccessToken(def.url ?? ""))
            : registerGoogleRestTools(name, def.rest, () => validAccessToken(def.url ?? ""));
        loaded.push(`${name} (${n} tools)`);
        continue;
      }
      if (def.url) {
        // A remote server is reached with a stored OAuth token when there is one. If it answers
        // 401 we record that and move on rather than failing the load: needing sign-in is a state
        // the user can fix from the Connectors screen, not a broken connector.
        const probe = await probeAuth(def.url, def.headers ?? {});
        if (probe.unauthorized) {
          needsAuth.set(name, probe.wwwAuthenticate);
          console.error(`mcp ${name}: needs sign-in`);
          continue;
        }
        needsAuth.delete(name);
        // Empty headers are dropped, not sent: an `Authorization: ""` placeholder would override
        // the OAuth bearer below it and turn a working sign-in into a 401.
        const liveHeaders = Object.fromEntries(Object.entries(def.headers ?? {}).filter(([, v]) => String(v ?? "").trim()));
        rpc = makeHttpClient(def.url, liveHeaders, probe.token ?? undefined);
      } else if (def.command) {
        // Scrub ada's own secrets from the third-party server's env; keep the server's OWN configured
        // creds (def.env) so it still works — but don't hand it every provider/admin/seat key.
        // shell:true so Windows resolves npx.cmd etc.; error handler so a missing command logs instead of crashing the process
        // windowsHide: an MCP server is a background process. Without it Electron pops a console window
        // for every stdio connector on every serve start — three connectors, three windows, each time
        // the config changes.
        const proc = spawn(def.command, def.args ?? [], { env: scrubbedEnv(def.env), stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32", windowsHide: true });
        proc.on("error", (e) => console.error(`mcp ${name}: ${e.message}`));
        trackMcpChild(proc);
        rpc = makeClient(proc);
      } else {
        console.error(`mcp ${name}: needs a "command" (stdio) or "url" (http)`);
        continue;
      }
      // Bounded, because a third-party server that never answers used to hang the whole load — and
      // with it every connector queued behind this one. 90s is generous on purpose: a cold `npx`
      // has to download the package before the server even starts.
      await withTimeout(name, rpc.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ada", version: "0.0.1" } }));
      rpc.notify("notifications/initialized");
      const list = await withTimeout(name, rpc.call("tools/list", {}));
      const mcpTools = (list.tools as Array<Record<string, unknown>>) ?? [];
      for (const t of mcpTools) {
        const toolName = String(t.name);
        registerTool({
          name: `${name}__${toolName}`,
          description: String(t.description ?? `${name} tool ${toolName}`),
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          needsApproval: true,
          async run(args) {
            try {
              // A connector that never answers must not wedge the turn. 5 min is generous: real work
              // (a build, a slow query) fits; a dead server does not.
              const res = await withTimeout(name, rpc.call("tools/call", { name: toolName, arguments: args }), 300_000);
              const content = (res.content as Array<Record<string, unknown>>) ?? [];
              const text = content.map((c) => (c.text != null ? String(c.text) : JSON.stringify(c))).join("\n");
              return { output: text || "(no content)", isError: !!res.isError };
            } catch (e) {
              return { output: String(e), isError: true };
            }
          },
        });
      }
      // Resources (optional): expose a read_resource tool listing the server's resource URIs.
      try {
        const rl = await rpc.call("resources/list", {});
        const resources = (rl.resources as Array<{ uri: string; name?: string }>) ?? [];
        if (resources.length) {
          registerTool({
            name: `${name}__read_resource`,
            description: `Read a resource from ${name}. Available URIs: ${resources.slice(0, 30).map((r) => (r.name ? `${r.uri} (${r.name})` : r.uri)).join("; ")}`,
            parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"], additionalProperties: false },
            needsApproval: true,
            async run(args) {
              try {
                const res = await rpc.call("resources/read", { uri: String(args.uri) });
                const contents = (res.contents as Array<{ text?: string; blob?: string }>) ?? [];
                return { output: contents.map((c) => c.text ?? (c.blob ? "[binary content]" : "")).join("\n") || "(empty)" };
              } catch (e) {
                return { output: String(e), isError: true };
              }
            },
          });
          loaded.push(`${name} (+${resources.length} resources)`);
        }
      } catch {
        /* server doesn't support resources */
      }
      loaded.push(`${name} (${mcpTools.length} tools)`);
    } catch (e) {
      console.error(`mcp ${name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return loaded;
}

// ---- connector catalog + .ada/mcp.json management (`ada mcp …`) ----

// A curated set of popular MCP connectors. `ada mcp add <name>` drops the entry into .ada/mcp.json.
// ponytail: package names track the public MCP servers — adjust an entry if an upstream renames.
// OAuth-only. A connector either signs you in through the browser or it takes NO login at all —
// nothing here asks you to paste a token, an API key, or a downloaded JSON file. The token-pasting
// connectors (the stdio github/slack/sentry packages, brave-search, the file-based Google
// packages) were removed for exactly that reason; every service that offers a hosted OAuth MCP
// server — GitHub, Slack, Sentry, Notion, Linear, Google Calendar — is here as a sign-in instead.
// Google's Gmail and Calendar MCP servers are in DEVELOPER PREVIEW. Enabling the APIs, holding the
// documented scopes and signing in successfully are all necessary and none of them are sufficient:
// the project must also be enrolled in the Google Workspace Developer Preview Program, which asks
// for "your Google Workspace account and Google Cloud project information". A personal @gmail.com
// account has no Workspace account to give, so it cannot enrol — and every call comes back "The
// caller does not have permission" with nothing anywhere saying why.
//
// Kept in the catalog because they work properly for a Workspace project that is enrolled. The
// description carries the requirement so nobody spends an evening on scopes that were never the
// problem. Declared above CATALOG, not below it — the literal reads it at module load.
const GOOGLE_PREVIEW_NOTE = " (needs Google Workspace Developer Preview enrollment)";

export const CATALOG: Record<string, { description: string; server: McpServerDef }> = {
  // Local tools that need no credential of any kind — they just run.
  filesystem: { description: "Local filesystem read/write", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
  puppeteer: { description: "Browser automation (Puppeteer)", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] } },
  memory: { description: "Persistent knowledge-graph memory", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },

  // Hosted connectors — sign in with your account, in the browser. The vendor runs the server and
  // owns the upstream app registration, so nothing is pasted and no console is visited. Most
  // advertise their own authorization server and Ada registers itself dynamically; Google is the
  // exception (it will not register clients), so its client id comes from Ada's backend.
  "sentry-remote": { description: "Sentry, hosted — sign in with your Sentry account", server: { url: "https://mcp.sentry.dev/mcp" } },
  "notion-remote": { description: "Notion, hosted — sign in with your Notion account", server: { url: "https://mcp.notion.com/mcp" } },
  "linear-remote": { description: "Linear, hosted — sign in with your Linear account", server: { url: "https://mcp.linear.app/mcp" } },
  // GitHub's and Slack's hosted servers authorize through github.com / slack.com OAuth (probed:
  // PKCE S256, no dynamic registration) — so like Google, the client id comes from Ada's backend
  // and the sign-in is one click once the backend holds Ada's registered app for the provider.
  // Scopes are the ones each server's own protected-resource metadata advertises.
  "github-remote": {
    description: "GitHub, hosted — sign in with your GitHub account",
    server: {
      url: "https://api.githubcopilot.com/mcp/",
      scopes: ["repo", "read:org", "read:user", "workflow"],
      oauth: { client_id: "" },
      oauthProvider: "github",
    },
  },
  // Slack is deliberately absent, and it is the one service here that CANNOT work as things stand.
  // Its MCP server is real (https://mcp.slack.com/mcp, OAuth + PKCE, no dynamic registration), but
  // Slack requires every redirect URL to be HTTPS — "A Redirect URL must also use HTTPS", with no
  // localhost carve-out — and Ada's sign-in redirects to http://127.0.0.1:<port>/callback, which is
  // what OAuth for native apps (RFC 8252) prescribes and what GitHub and Google both accept.
  //
  // So listing it would mean shipping a Sign in button that fails at Slack's consent screen with a
  // redirect_uri error, no matter what credentials the backend holds. It comes back the day Ada has
  // a hosted HTTPS callback to redirect through; nothing else about the flow needs to change.
  // Google's own MCP servers for these two are gated behind the Workspace Developer Preview: a
  // correct token, correct scopes and both APIs enabled still return "The caller does not have
  // permission" unless the project is enrolled. Their ORDINARY REST APIs have no such gate and
  // answer the same token, so `rest` sends the tools there instead. `url` is kept as the token's
  // identity — it is what the sign-in was granted against, and switching it would orphan every
  // existing sign-in. If the preview ever lands, dropping `rest` restores the MCP path.
  "google-calendar-remote": {
    description: `Google Calendar — today's events, attendees and free/busy${GOOGLE_PREVIEW_NOTE}`,
    server: {
      url: "https://calendarmcp.googleapis.com/mcp/v1",
      scopes: [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
      // Empty here; filled from the client id Ada's backend publishes. Google does not offer
      // dynamic registration, so without a backend-held client this connector has no sign-in.
      oauth: { client_id: "" },
      oauthProvider: "google",
      rest: "calendar",
    },
  },
  x: {
    description: "X (Twitter) — publish a post as the connected account. Drafts first; posting always asks.",
    server: {
      // Not an MCP endpoint: it identifies the token in the auth store and is the API the tools call.
      url: "https://api.x.com/2",
      // tweet.write is the posting grant; users.read identifies the account; offline.access is what
      // makes a refresh token appear, without which a scheduled post stops working within hours.
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      oauth: { client_id: "" },
      oauthProvider: "x",
      oauthEndpoints: {
        authorization_endpoint: "https://x.com/i/oauth2/authorize",
        token_endpoint: "https://api.x.com/2/oauth2/token",
      },
      rest: "x",
    },
  },
  linkedin: {
    description: "LinkedIn — publish a post as you, or as a company page. Drafts first; posting always asks.",
    server: {
      url: "https://api.linkedin.com/rest",
      // openid+profile are what /v2/userinfo needs to resolve the author URN; w_member_social is the
      // posting grant. Posting as a COMPANY PAGE additionally needs w_organization_social, which is
      // granted per app by LinkedIn review rather than by the member consenting.
      scopes: ["openid", "profile", "w_member_social"],
      oauth: { client_id: "" },
      oauthProvider: "linkedin",
      oauthEndpoints: {
        authorization_endpoint: "https://www.linkedin.com/oauth/v2/authorization",
        token_endpoint: "https://www.linkedin.com/oauth/v2/accessToken",
      },
      rest: "linkedin",
    },
  },
  "gmail-remote": {
    description: `Gmail — search and read mail, and draft replies (never sends)${GOOGLE_PREVIEW_NOTE}`,
    server: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      // The two scopes Google documents for Gmail. `gmail.modify` was the obvious choice — one
      // scope covering everything — and it is rejected: these are the pair the API expects, and
      // they are also exactly what the REST tools need. `readonly` reads, `compose` drafts.
      //
      // Gmail scopes are RESTRICTED rather than merely sensitive, so shipping this publicly needs
      // restricted-scope verification and its annual third-party security assessment.
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
      oauth: { client_id: "" },
      oauthProvider: "google",
      rest: "gmail",
    },
  },
};

/**
 * Connectors belong to YOU, not to a checkout.
 *
 * This used to be `./.ada/mcp.json`, per project — so connecting Gmail while one folder was open
 * did nothing for a scheduled task running in another, and the same account had to be connected
 * once per repository. Your mailbox and calendar do not change per repo. The tokens were already
 * global (`~/.ada/mcp-auth.json`), so the config being local was the odd one out: a connector could
 * be signed in and simultaneously not exist.
 *
 * ADA_MCP_CONFIG overrides it, which is what the tests use instead of writing to a real home.
 */
function configPath(): string {
  return process.env.ADA_MCP_CONFIG || join(homedir(), ".ada", "mcp.json");
}

/** The old per-project location, kept only long enough to carry existing setups over. */
function legacyConfigPath(): string {
  return resolve(process.cwd(), ".ada", "mcp.json");
}

/**
 * First run after connectors went global: adopt whatever this project had, so nobody opens the
 * screen to find them gone. Copied rather than read-through — one file is the point.
 *
 * Called from BOTH the reader and the loader. Putting it only in readConfig() meant an agent turn,
 * which goes straight to loadMcpServers, ran before anything had migrated — and loaded nothing.
 */
function ensureConfigMigrated(): void {
  const p = configPath();
  if (existsSync(p) || !existsSync(legacyConfigPath())) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, readFileSync(legacyConfigPath(), "utf8"));
    console.error(`mcp: connectors are global now — carried over from ${legacyConfigPath()}`);
  } catch {
    /* best effort: a failed migration must not stop the connectors from loading */
  }
}

function readConfig(): { servers: Record<string, McpServerDef> } {
  ensureConfigMigrated();
  const p = configPath();
  if (!existsSync(p)) return { servers: {} };
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as { servers?: Record<string, McpServerDef> };
    return { servers: c.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

function writeConfig(cfg: { servers: Record<string, McpServerDef> }): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Add a catalog connector to .ada/mcp.json. Returns the env vars the user still needs to set. */
export function addConnector(name: string): { ok: boolean; envVars: string[]; error?: string } {
  const entry = CATALOG[name];
  if (!entry) return { ok: false, envVars: [], error: `unknown connector "${name}" — run \`ada mcp\` to list the catalog` };
  const cfg = readConfig();
  cfg.servers[name] = entry.server;
  writeConfig(cfg);
  return { ok: true, envVars: Object.keys(entry.server.env ?? {}) };
}

/** Add a custom (non-catalog) server to .ada/mcp.json. */
export function addCustomServer(name: string, def: McpServerDef): { ok: boolean; error?: string } {
  if (!def.command && !def.url) return { ok: false, error: 'needs a "command" (stdio) or "url" (http)' };
  const cfg = readConfig();
  cfg.servers[name] = def;
  writeConfig(cfg);
  return { ok: true };
}


/**
 * Give a connector the OAuth client id it cannot obtain for itself.
 *
 * Only for servers that refuse dynamic registration. Stored per connector so the id travels with
 * the config, and cleared rather than stored empty — an empty client id would make `beginLogin`
 * think one was supplied and fail with the wrong message.
 */
export function setConnectorOauthClient(name: string, client: { client_id: string }): { ok: boolean; error?: string } {
  const cfg = readConfig();
  const server = cfg.servers[name];
  if (!server) return { ok: false, error: `"${name}" is not connected — add it first` };
  if (!server.url) return { ok: false, error: `"${name}" runs locally — it takes credentials from its settings` };
  if (!client.client_id?.trim()) delete server.oauth;
  else server.oauth = { client_id: client.client_id.trim() };
  writeConfig(cfg);
  return { ok: true };
}

/** Connectors that are configured but still missing the client id they cannot register themselves. */
export async function needsOauthClient(): Promise<string[]> {
  const cfg = readConfig();
  const waiting = Object.entries(cfg.servers).filter(
    ([name, def]) => def.url && !def.oauth?.client_id && CATALOG[name]?.server.oauth !== undefined,
  );
  const out: string[] = [];
  for (const [name] of waiting) {
    // The backend signing in to this provider is the same as having a client here: nobody has to be
    // asked for one, so the connector is ready rather than waiting on setup.
    const provider = CATALOG[name]?.server.oauthProvider;
    if (provider && (await backendHasProvider(provider))) continue;
    out.push(name);
  }
  return out;
}

/** Remove a connector from .ada/mcp.json. */
export function removeConnector(name: string): boolean {
  const cfg = readConfig();
  const def = cfg.servers[name];
  if (!def) return false;
  delete cfg.servers[name];
  writeConfig(cfg);
  // And forget the sign-in. Leaving the token behind made "Remove" a half-measure: the connector
  // vanished from the list while its credentials stayed on disk, so adding it back reported itself
  // as already signed in — with whatever scopes the OLD token happened to carry. Someone removing
  // a connector to re-authorise it got the exact token they were trying to replace.
  if (def.url) clearAuth(def.url);
  needsAuth.delete(name);
  loginTimes.delete(name);
  loginErrors.delete(name);
  return true;
}

/** Names of the servers currently configured in .ada/mcp.json. */
export function configuredServers(): string[] {
  return Object.keys(readConfig().servers);
}

/**
 * The catalog annotated with whether each connector is already in .ada/mcp.json.
 *
 * `missingEnv` is the difference between "added" and "actually usable": a connector whose token is
 * still an empty placeholder is configured and will not work, and the UI could not tell the two
 * apart from `needsEnv` alone — that only says which keys EXIST, never which are filled.
 *
 * Servers you added yourself are included too, flagged `custom`. They were omitted entirely, so
 * adding a custom server made it vanish from the very screen you added it on.
 */
export function listConnectors(): {
  name: string;
  /** What to SHOW. "github-remote" is an id — an implementation detail of the catalog; "GitHub" is
   *  the thing the user recognises. Derived here so the app never has to parse ids for display. */
  label: string;
  description: string;
  configured: boolean;
  needsEnv: string[];
  missingEnv: string[];
  needsHeader: string[];
  type: "local" | "remote";
  custom: boolean;
}[] {
  const cfg = readConfig();
  const out = Object.entries(CATALOG).map(([name, e]) => {
    const live = cfg.servers[name];
    return {
      name,
      label: prettyName(name),
      description: e.description,
      configured: !!live,
      // Headers are reported alongside env because a remote server without dynamic registration
      // takes its credential there — treated separately, github-remote looked complete while its
      // Authorization header was still an empty placeholder.
      needsEnv: [...Object.keys(e.server.env ?? {}), ...Object.keys(e.server.headers ?? {})],
      missingEnv: live
        ? [
            ...Object.entries(live.env ?? {}).filter(([, v]) => !v),
            ...Object.entries(live.headers ?? {}).filter(([, v]) => !String(v ?? "").trim()),
          ].map(([k]) => k)
        : [],
      needsHeader: Object.keys(e.server.headers ?? {}),
      type: (e.server.url ? "remote" : "local") as "local" | "remote",
      custom: false,
    };
  });
  for (const [name, def] of Object.entries(cfg.servers)) {
    if (CATALOG[name]) continue;
    out.push({
      name,
      // A hand-added server keeps the name its owner gave it — prettifying someone's own id would
      // be us renaming their thing.
      label: name,
      description: def.url ?? [def.command, ...(def.args ?? [])].join(" "),
      configured: true,
      needsEnv: [...Object.keys(def.env ?? {}), ...Object.keys(def.headers ?? {})],
      missingEnv: [
        ...Object.entries(def.env ?? {}).filter(([, v]) => !v),
        ...Object.entries(def.headers ?? {}).filter(([, v]) => !String(v ?? "").trim()),
      ].map(([k]) => k),
      needsHeader: Object.keys(def.headers ?? {}),
      type: (def.url ? "remote" : "local") as "local" | "remote",
      custom: true,
    });
  }
  return out;
}

/**
 * Sign in to a remote connector. Returns the consent URL immediately so the caller can open a
 * browser, and a promise that settles when the redirect lands — the two halves are separate
 * because the process that opens the browser is not always the one that waits.
 */
/** Catalog id -> the service's own name: "google-calendar-remote" -> "Google Calendar". */
function prettyName(name: string): string {
  const cased: Record<string, string> = { github: "GitHub", gitlab: "GitLab" };
  return name
    .replace(/-remote$/, "")
    .split("-")
    .map((w) => cased[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function loginConnector(name: string): Promise<{ ok: boolean; url?: string; finish?: () => Promise<{ ok: boolean; error?: string }>; error?: string }> {
  const def = readConfig().servers[name];
  if (!def) return { ok: false, error: `"${name}" is not connected` };
  if (!def.url) return { ok: false, error: `"${name}" runs locally — it takes credentials from its settings, not a sign-in` };
  const started = await beginLogin(def.url, needsAuth.get(name) ?? null, {
    client: def.oauth?.client_id ? def.oauth : undefined,
    scopes: def.scopes,
    label: prettyName(name), // names the service on the page the browser lands on
    // Only set for providers that publish no discovery metadata (X, LinkedIn). Absent for everyone
    // else, so the normal chain still runs and a config file cannot redirect a sign-in.
    meta: def.oauthEndpoints,
  });
  if ("error" in started) return { ok: false, error: started.error };
  loginErrors.delete(name);
  return {
    ok: true,
    url: started.url,
    // The token exchange happens AFTER this response — the browser half outlives it — so its
    // failure has nowhere to be returned to. Recording it is what lets the app say "the provided
    // client secret is invalid" instead of waiting out its poll and shrugging. That exact case
    // (a wrong secret on the backend) was otherwise indistinguishable from a user walking away.
    finish: async () => {
      const done = await started.finish();
      if (!done.ok) loginErrors.set(name, done.error ?? "sign-in failed");
      else loginTimes.set(name, Date.now());
      return done;
    },
  };
}

/** Why this connector's last sign-in failed, if it did. Cleared when a new sign-in starts. */
const loginErrors = new Map<string, string>();

export function lastLoginError(name: string): string | undefined {
  return loginErrors.get(name);
}

/**
 * When a sign-in for this connector last COMPLETED.
 *
 * `signedIn` only means "a token exists", which is not the same question. Removing a connector
 * leaves its token behind (tokens are keyed by server URL, and are reusable), so reconnecting found
 * a stale token already in the store and the app declared the sign-in finished the instant it
 * started — the row said Signed in while the consent screen was still open in the browser. The same
 * thing happened re-signing in to fix a token's scopes: nothing had to change for it to "succeed".
 *
 * A timestamp distinguishes "there is a token" from "a sign-in just happened", which is what the
 * app is actually waiting for. In memory only: an engine restart loses it, and the fallback is the
 * old behaviour rather than a stuck spinner.
 */
const loginTimes = new Map<string, number>();

export function lastLoginAt(name: string): number | undefined {
  return loginTimes.get(name);
}

/** Forget a connector's tokens — the "sign out" half of sign-in. */
export function logoutConnector(name: string): boolean {
  const def = readConfig().servers[name];
  if (!def?.url) return false;
  clearAuth(def.url);
  needsAuth.delete(name);
  return true;
}

/** Whether we hold a token for this server at all (not whether it still works). */
export function hasStoredAuth(name: string): boolean {
  const def = readConfig().servers[name];
  return !!(def?.url && getAuth(def.url));
}
