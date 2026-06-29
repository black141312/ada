---
name: grpc-service
description: Define a gRPC service from proto through generated stubs to a working server and client
category: networking
---

# gRPC Service

Reach for this when adding RPC between services and you want a typed contract, code-gen, and streaming. Best when both ends are yours.

1. Write a `.proto` (`syntax = "proto3";`) with a `package`, a `service` block, and `rpc` methods; give every method a dedicated request and response message (never reuse one message for both).
2. Pick the right method shape per call: unary, server-streaming (`returns (stream X)`), client-streaming (`(stream X)`), or bidi.
3. Generate stubs with `protoc` (or `buf generate`) for your language, and check generated code into the build, not the repo unless that's the convention.
4. Implement the server: bind the service to a server object, register interceptors for auth/logging, and serve on a port with a health check (`grpc.health.v1`).
5. Build the client with a channel/stub, set per-call deadlines (`context` timeout / `CallOptions`), and handle the typed status codes.
6. Test with `grpcurl -plaintext host:port list` and a real client call before wiring callers.

## Rules
- Never renumber or reuse field tags; mark removed fields `reserved`. Tag numbers are the wire contract, not the field names.
- Always set a deadline on every client call — gRPC has no default timeout and a hung server blocks the caller forever.
- Return proper `status` codes (`NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE`), not `UNKNOWN` for everything.
- Enable TLS for anything off-localhost; `plaintext` is for local dev and tests only.
- Make handlers idempotent where possible — clients retry `UNAVAILABLE`/`DEADLINE_EXCEEDED` automatically with some configs.
