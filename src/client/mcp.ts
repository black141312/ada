// Minimal MCP client (stdio, JSON-RPC 2.0). Reads .ada/mcp.json, spawns each server, lists its
// tools, and registers them as ada tools (prefixed `<server>__<tool>`, gated behind approval).
// Config: { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { registerTool } from "./tools.ts";
import { scrubbedEnv } from "./secret-env.ts";

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
function makeHttpClient(url: string, headers: Record<string, string>): RpcClient {
  let nextId = 1;
  let sessionId: string | undefined;
  const post = (body: unknown): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...headers },
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
  readServers(resolve(process.cwd(), ".ada", "mcp.json"));
  const loaded: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    try {
      let rpc: RpcClient;
      if (def.url) {
        rpc = makeHttpClient(def.url, def.headers ?? {});
      } else if (def.command) {
        // Scrub ada's own secrets from the third-party server's env; keep the server's OWN configured
        // creds (def.env) so it still works — but don't hand it every provider/admin/seat key.
        // shell:true so Windows resolves npx.cmd etc.; error handler so a missing command logs instead of crashing the process
        const proc = spawn(def.command, def.args ?? [], { env: scrubbedEnv(def.env), stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32" });
        proc.on("error", (e) => console.error(`mcp ${name}: ${e.message}`));
        rpc = makeClient(proc);
      } else {
        console.error(`mcp ${name}: needs a "command" (stdio) or "url" (http)`);
        continue;
      }
      await rpc.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ada", version: "0.0.1" } });
      rpc.notify("notifications/initialized");
      const list = await rpc.call("tools/list", {});
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
              const res = await rpc.call("tools/call", { name: toolName, arguments: args });
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
export const CATALOG: Record<string, { description: string; server: McpServerDef }> = {
  filesystem: { description: "Local filesystem read/write", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
  github: { description: "GitHub repos, issues, PRs", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } } },
  git: { description: "Local git repository operations", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-git", "--repository", "."] } },
  postgres: { description: "Postgres (read-only SQL)", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/postgres"] } },
  sqlite: { description: "SQLite database", server: { command: "npx", args: ["-y", "mcp-server-sqlite", "--db-path", "./db.sqlite"] } },
  fetch: { description: "Fetch and convert web pages", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] } },
  "brave-search": { description: "Web search via Brave", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" } } },
  puppeteer: { description: "Browser automation (Puppeteer)", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] } },
  slack: { description: "Slack channels and messages", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" } } },
  memory: { description: "Persistent knowledge-graph memory", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
  sentry: { description: "Sentry issues and events", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sentry"], env: { SENTRY_AUTH_TOKEN: "" } } },
};

function configPath(): string {
  return resolve(process.cwd(), ".ada", "mcp.json");
}

function readConfig(): { servers: Record<string, McpServerDef> } {
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

/** Remove a connector from .ada/mcp.json. */
export function removeConnector(name: string): boolean {
  const cfg = readConfig();
  if (!cfg.servers[name]) return false;
  delete cfg.servers[name];
  writeConfig(cfg);
  return true;
}

/** Names of the servers currently configured in .ada/mcp.json. */
export function configuredServers(): string[] {
  return Object.keys(readConfig().servers);
}

/** The catalog annotated with whether each connector is already in .ada/mcp.json. */
export function listConnectors(): { name: string; description: string; configured: boolean; needsEnv: string[] }[] {
  const cfg = readConfig();
  return Object.entries(CATALOG).map(([name, e]) => ({
    name,
    description: e.description,
    configured: !!cfg.servers[name],
    needsEnv: Object.keys(e.server.env ?? {}),
  }));
}
