---
name: connect-remote
description: Connect ada to a remote/hosted MCP server over HTTP (Streamable HTTP) instead of stdio.
category: connectors
---

# Connect Remote (HTTP)

Use when the connector is a hosted MCP endpoint (a URL) rather than a local command.

1. Get the server's HTTP endpoint URL and any auth header it requires (usually `Authorization: Bearer <token>`).
2. Add an entry to `.ada/mcp.json` with a `url` (not `command`):
   ```json
   { "servers": { "remote": { "url": "https://mcp.example.com/v1", "headers": { "Authorization": "Bearer <token>" } } } }
   ```
3. Keep the token in an env var and reference it, or paste it only into the local (gitignored) `.ada/mcp.json`.
4. Trust the project and start `ada`; ada POSTs JSON-RPC and reads the JSON/SSE response, registering tools as `remote__*`.
5. Confirm the server is up with a read-only tool before relying on it.

## Rules
- Only point at endpoints you trust — a remote server sees the arguments ada sends it.
- Prefer HTTPS; never send tokens over plain HTTP.
- ada's HTTP transport is request/response (no resumable streams) — long-running server pushes aren't supported.
