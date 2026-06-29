#!/usr/bin/env node
// Minimal stdio LSP server for selfcheck/integration: answers `initialize` and, on `didOpen`,
// publishes one diagnostic for the opened file. Content-Length framed JSON-RPC. Exits on stdin close.
import { stdin, stdout } from "node:process";

const send = (msg) => {
  const j = JSON.stringify(msg);
  stdout.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`);
};

let buf = Buffer.alloc(0);
stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he < 0) break;
    const m = buf.slice(0, he).toString("ascii").match(/content-length:\s*(\d+)/i);
    const start = he + 4;
    if (!m) {
      buf = buf.slice(start);
      continue;
    }
    const len = Number(m[1]);
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString("utf8");
    buf = buf.slice(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    } else if (msg.method === "textDocument/didOpen") {
      const uri = msg.params?.textDocument?.uri;
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "stub diagnostic", source: "stub" }] },
      });
    }
    // initialized / didChange / others are ignored
  }
});
stdin.on("end", () => process.exit(0));
stdin.on("close", () => process.exit(0));
