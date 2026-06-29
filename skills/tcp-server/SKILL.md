---
name: tcp-server
description: Write a TCP or UDP server with correct framing, concurrency, timeouts, and graceful shutdown
category: networking
---

# TCP / UDP Server

Reach for this when implementing a custom wire protocol or a low-level network service below HTTP. Choose TCP for ordered, reliable streams; UDP for low-latency, loss-tolerant datagrams.

1. Bind and listen, then accept connections in a loop, handing each to its own handler (goroutine/thread/async task) so one slow client can't block others.
2. Define framing for TCP — length-prefix or a delimiter — because TCP is a byte stream with no message boundaries; never assume one read equals one message.
3. Read in a loop into a buffer until you have a full frame; handle partial reads, coalesced messages, and split messages across reads.
4. Set read/write/idle deadlines per connection so dead or stalled peers get closed instead of leaking.
5. For UDP, handle each datagram independently — no connection state, expect loss/reordering/duplication, and validate every packet's size and contents.
6. Implement graceful shutdown: stop accepting, signal handlers to drain, close listeners, and wait (with a timeout) for in-flight connections.

## Rules
- TCP has no message boundaries — always frame explicitly; relying on read sizes is the classic bug.
- Cap per-message and total per-connection buffer sizes; an attacker sending a huge length prefix can OOM you.
- Always set socket deadlines; without them a half-open connection (peer vanished) hangs a handler forever.
- Limit concurrent connections (a semaphore/accept limiter) so the server degrades instead of falling over under load.
- For UDP, never trust the source address blindly — it's trivially spoofed; don't use it alone for auth or amplification-prone replies.
