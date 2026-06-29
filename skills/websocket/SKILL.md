---
name: websocket
description: Implement a WebSocket server or client with proper handshake, heartbeats, and reconnection
category: networking
---

# WebSocket

Use for low-latency, bidirectional, long-lived connections (live feeds, chat, collaborative cursors). If the client only ever reads, prefer SSE; if it's request/response, prefer HTTP.

1. Establish the connection: server upgrades the HTTP request (`Upgrade: websocket`), validating `Origin` and authenticating during the handshake (token in query/subprotocol, not after).
2. Define a message protocol — pick JSON or binary, give every message a `type`, and version it so you can evolve the schema.
3. Add ping/pong heartbeats on a timer; close connections that miss N pongs so dead peers and half-open NAT connections get reaped.
4. On the client, implement reconnect with exponential backoff + jitter and resubscribe/replay state after reconnecting.
5. Apply backpressure: bound the send queue per connection and drop or disconnect slow consumers instead of buffering unbounded.
6. Handle clean shutdown — send a close frame with a status code, drain in-flight messages, and remove the connection from any registries.

## Rules
- Always validate `Origin` (and auth) at handshake time; an open upgrade endpoint is a CSRF/abuse vector.
- Never trust message size — cap frame/message length and reject oversized payloads to avoid memory blowups.
- A WebSocket is not reliable delivery: design for dropped connections, duplicate messages on reconnect, and out-of-order resends.
- Use `wss://` in production; plain `ws://` breaks under TLS-terminating proxies and leaks tokens.
- Don't do heavy work in the read loop — hand messages to workers so one slow handler can't stall the socket.
