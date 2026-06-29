---
name: agent-loop
description: Build a minimal agent loop that streams, calls tools, and repeats until done
category: agent-llm
---

# Agent Loop

Reach for this to implement the core "model decides, tools run, repeat" cycle that turns a chat completion into an agent.

1. Seed a message list with a system prompt (role, tools available, stop conditions) and the user's request.
2. Call the model with the messages and the tool schemas; stream tokens to the user as they arrive.
3. If the response contains tool calls, append the assistant turn, execute each tool, and append a tool-result message per call.
4. Loop back to step 2 with the appended results; if the response has no tool calls, it's the final answer — stop.
5. Cap iterations (e.g. max 10) and total tokens to prevent runaway loops; surface a clear message when a cap is hit.
6. Handle errors per tool — return the error text as the tool result so the model can retry or change approach, rather than crashing the loop.

## Rules
- Always append the assistant's tool-call turn BEFORE the tool results, in the order the API expects, or the next call rejects the history.
- Execute independent tool calls concurrently, but preserve result ordering when appending them back.
- Enforce a hard iteration cap and a wall-clock/token budget; an agent with no brake will spin.
- Make tool execution idempotent or guard destructive actions, since the model may retry after a transient error.
- Stream text deltas but buffer tool-call arguments until complete — partial JSON is not parseable.
