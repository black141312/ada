---
name: connect-mcp
description: Add an MCP connector to ada (catalog via `ada mcp add`, or a custom server in .ada/mcp.json).
category: connectors
---

# Connect MCP

Use when the user wants ada to reach an external tool or data source (GitHub, a database, the web, …).

1. List the catalog: `ada mcp` (● = configured, ○ = available, plus the env vars each needs).
2. If the connector is in the catalog, add it: `ada mcp add <name>` (writes `.ada/mcp.json`).
3. For anything not in the catalog, add an entry to `.ada/mcp.json` by hand — `{ command, args, env }` for a local stdio server, or `{ url, headers }` for a remote HTTP one.
4. Set any required env vars (the `add` command prints them); never put secrets in `.ada/mcp.json`.
5. Make sure the project is trusted (MCP loads only in trusted projects), then start `ada` — the connector's tools appear as `<server>__<tool>`.

## Rules
- MCP servers run code/network — only enable ones you trust, in trusted projects.
- Every MCP tool is approval-gated; expect a prompt before each call.
- Keep tokens in env vars; reference them via the server's `env`, don't hardcode.
- If tools don't appear, run ada from the project root and check the server starts standalone.
