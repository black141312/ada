# Connectors (MCP)

ada connects to external tools and data through the **Model Context Protocol (MCP)**. Each connector
is an MCP server; ada spawns or calls it, lists its tools, and registers them as ada tools named
`<server>__<tool>` — approval-gated, and only loaded for **trusted projects**.

## Quick start

```bash
ada mcp                       # list the connector catalog (● configured · ○ available)
ada mcp add github            # write the github entry into .ada/mcp.json
ada mcp remove github         # remove it
```

After `add`, set any env vars it prints (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`), then start `ada` in
that project — the connector's tools appear automatically.

## Catalog

`filesystem` · `github` · `git` · `postgres` · `sqlite` · `fetch` · `brave-search` · `puppeteer` ·
`slack` · `memory` · `sentry`. Run `ada mcp` for the live list and which env vars each needs.

## Config: `.ada/mcp.json`

`ada mcp add` edits this file, but you can also write entries by hand. Two transports:

```jsonc
{
  "servers": {
    // local stdio server (a subprocess)
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    // remote server over Streamable HTTP
    "remote": { "url": "https://mcp.example.com/v1", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

- **stdio** — `{ command, args, env }`: ada launches the process and speaks JSON-RPC over stdin/stdout.
- **http** — `{ url, headers }`: ada POSTs JSON-RPC and reads a JSON or SSE response (Streamable HTTP).

## Notes

- MCP servers run code / reach the network, so they load **only in trusted projects** (the same trust
  gate as `.ada` prompts and settings). Untrusted projects skip them.
- Every MCP tool is **approval-gated** — ada prompts before each call.
- Secrets come from **env vars** (referenced in the server's `env`), never committed to `.ada/mcp.json`.
- See the `connectors` skill category (`list_skills {category: "connectors"}`) for per-connector setup
  walk-throughs, and the `mcp-server` skill to build your own.
