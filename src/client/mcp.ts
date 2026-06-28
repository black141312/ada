// Minimal MCP client (stdio, JSON-RPC 2.0). Reads .ada/mcp.json, spawns each server, lists its
// tools, and registers them as ada tools (prefixed `<server>__<tool>`, gated behind approval).
// Config: { "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerTool } from "./tools.ts";

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

interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export async function loadMcpServers(includeProject: boolean): Promise<string[]> {
  if (!includeProject) return []; // MCP servers run code — trusted projects only
  const cfgPath = resolve(process.cwd(), ".ada", "mcp.json");
  if (!existsSync(cfgPath)) return [];
  let cfg: { servers?: Record<string, McpServerDef> };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [name, def] of Object.entries(cfg.servers ?? {})) {
    try {
      const proc = spawn(def.command, def.args ?? [], { env: { ...process.env, ...def.env }, stdio: ["pipe", "pipe", "ignore"] });
      const rpc = makeClient(proc);
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
      loaded.push(`${name} (${mcpTools.length} tools)`);
    } catch (e) {
      console.error(`mcp ${name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return loaded;
}
