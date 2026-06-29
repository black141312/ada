---
name: mcp-server
description: Scaffold an MCP server that exposes tools over stdio or HTTP for an LLM agent to call
category: agent-llm
---

# MCP Server

Reach for this when you need to expose local capabilities (files, APIs, DB queries) to an agent via the Model Context Protocol instead of hand-rolling a custom integration.

1. Pick a transport: stdio for local/CLI use (the default, simplest), or HTTP/SSE for a remote or multi-client server.
2. Init the project and add the MCP SDK (`@modelcontextprotocol/sdk` for TS, `mcp` for Python); create a server with a name and version.
3. Register each tool with a unique name, a one-line description, and a JSON-Schema (or zod/pydantic) input schema — keep inputs flat and typed.
4. Implement each tool handler to do the work, then return content as a list of typed parts (text/json); never return raw exceptions.
5. Wire the transport and start the loop (stdio: read/write over stdin/stdout; HTTP: bind a port and mount the session handler).
6. Register the server in the client config (command + args for stdio, URL for HTTP) and smoke-test that tools list and a sample call both succeed.

## Rules
- For stdio, NEVER write logs or prints to stdout — it corrupts the protocol stream; log to stderr or a file.
- Tool names must be stable and unique; renaming one breaks any agent that hardcoded it.
- Validate and sanitize every input inside the handler; schema validation is a hint, not a security boundary.
- Return structured errors (a result with `isError: true` and a message) so the agent can recover, rather than throwing.
- Keep each tool single-purpose and side-effect-explicit; mark destructive tools clearly in the description.
