#!/usr/bin/env node
// Minimal stdio MCP server used by selfcheck to exercise the connector + toolsmith path.
// Implements just enough JSON-RPC: initialize, tools/list, tools/call. Exits when stdin closes.
import { stdin, stdout } from "node:process";

const send = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);
const TOOLS = [
  { name: "echo", description: "Echo back the given text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];

let buf = "";
stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stub", version: "0.0.1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `stub:${msg.params?.name}` }] } });
    else if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: {} });
    // notifications (no id) are ignored
  }
});
stdin.on("end", () => process.exit(0));
stdin.on("close", () => process.exit(0));
