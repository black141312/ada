// Extended thinking through the native Anthropic adapter, driven against a fake Messages API.
//
// The thing worth testing is the ROUND TRIP, not one request: the assistant turn that called a tool
// has to go back to Anthropic with the exact thinking block it produced still on the front,
// signature and all — and the OpenAI wire format the client speaks has nowhere to carry one. Drop
// it and the model loses its own reasoning across every tool call; replay it altered and Anthropic
// rejects the signature.
//   run: node --import tsx test/anthropic-thinking.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const THOUGHT = "The user wants a listing. ls is the tool for that.";
const SIGNATURE = "EqQBCgIYAhIsSgnedFakeSignature==";

const seen = []; // every request body the adapter sent

const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

/** One Anthropic streamed turn: a thinking block, then a tool call. */
const TURN = [
  sse("message_start", {
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }),
  sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: THOUGHT } }),
  sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: SIGNATURE } }),
  sse("content_block_stop", { index: 0 }),
  sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "ls", input: {} } }),
  sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } }),
  sse("content_block_stop", { index: 1 }),
  sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 25 } }),
  sse("message_stop", {}),
].join("");

/** A plain text answer, no thinking and no tools — what the retry gets back. */
const PLAIN = [
  sse("message_start", {
    message: { id: "msg_2", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
  }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "no thinking here" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
  sse("message_stop", {}),
].join("");

// Set to make the fake API reject any request that asks for thinking — a stand-in for a model that
// doesn't support it, or a provider that turns strict about thinking blocks.
let refuseThinking = false;
// Set to make the fake API die AFTER it has already streamed part of an answer.
let failMidStream = false;

const srv = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    if (failMidStream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Flush first and cut the connection a beat later, so the client really has consumed the
      // deltas before it sees the failure — writing and destroying in the same tick just looks
      // like a connect-phase error.
      res.write(TURN.slice(0, TURN.indexOf("event: content_block_stop")));
      setTimeout(() => res.destroy(), 200);
      return;
    }
    if (refuseThinking && body.thinking) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking is not supported by this model" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body.thinking ? TURN : PLAIN);
  });
});
await new Promise((r) => srv.listen(0, r));

process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const { anthropicAdapter } = await import(pathToFileURL(resolve("src/server/providers/anthropic.ts")).href);

/** Minimal ServerResponse stand-in — the adapter only writes SSE to it. */
function fakeRes() {
  const out = [];
  return {
    out,
    writeHead: () => {},
    write: (s) => (out.push(String(s)), true),
    end: () => {},
    frames: () =>
      out
        .join("")
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => JSON.parse(l.slice(6))),
  };
}

const call = async (body) => {
  const res = fakeRes();
  await anthropicAdapter.chat({ provider: "anthropic", model: body.model, body, res });
  return res;
};

const TOOLS = [{ type: "function", function: { name: "ls", description: "list", parameters: { type: "object", properties: {} } } }];

// --- turn 1: reasoning_effort actually turns thinking on ------------------------------------
const first = await call({
  model: "claude-test",
  reasoning_effort: "high",
  tools: TOOLS,
  messages: [
    { role: "system", content: "be helpful" },
    { role: "user", content: "list the files" },
  ],
});

const req1 = seen[0];
assert.deepEqual(req1.thinking, { type: "enabled", budget_tokens: 16384 }, "reasoning_effort:high enables thinking with a real budget");
assert.ok(req1.max_tokens > req1.thinking.budget_tokens, "max_tokens leaves room to answer after the thinking budget is spent");

const frames1 = first.frames();
const reasoning = frames1.map((f) => f.choices?.[0]?.delta?.reasoning_content).filter(Boolean).join("");
assert.equal(reasoning, THOUGHT, "thinking_delta is re-emitted as reasoning_content — the field the client reads");
const content = frames1.map((f) => f.choices?.[0]?.delta?.content).filter(Boolean).join("");
assert.equal(content, "", "and never as content — that would fold scratch work into the answer");
const toolFrames = frames1.flatMap((f) => f.choices?.[0]?.delta?.tool_calls ?? []);
assert.equal(toolFrames[0]?.id, "toolu_01", "the tool call still comes through");
assert.equal(toolFrames.map((t) => t.function?.arguments ?? "").join(""), '{"path":"."}', "with its arguments intact");
assert.equal(frames1.at(-2)?.choices?.[0]?.finish_reason, "tool_calls", "and the turn ends as a tool call");

// --- turn 2: the same transcript, now carrying the tool result ------------------------------
// The assistant turn has a tool_use and, in the OpenAI format, no thinking block anywhere — the
// adapter has to put it back from what it saw on the way out.
await call({
  model: "claude-test",
  reasoning_effort: "high",
  tools: TOOLS,
  messages: [
    { role: "system", content: "be helpful" },
    { role: "user", content: "list the files" },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_01", type: "function", function: { name: "ls", arguments: '{"path":"."}' } }] },
    { role: "tool", tool_call_id: "toolu_01", content: "a.txt\nb.txt" },
  ],
});

const req2 = seen[1];
const assistant = req2.messages.find((m) => m.role === "assistant");
assert.equal(assistant.content[0].type, "thinking", "turn 2 replays the thinking block ahead of the tool call");
assert.equal(assistant.content[0].thinking, THOUGHT, "verbatim");
assert.equal(assistant.content[0].signature, SIGNATURE, "signature included verbatim — Anthropic rejects an altered one");
assert.equal(assistant.content[1].type, "tool_use", "with the call itself right behind it");
assert.deepEqual(req2.thinking, { type: "enabled", budget_tokens: 16384 }, "so thinking stays on for the follow-up");

// --- a provider that refuses thinking: retry without it, don't burn the user's turn ---------
{
  refuseThinking = true;
  const before = seen.length;
  const res = await call({ model: "claude-test", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
  refuseThinking = false;

  const tries = seen.slice(before);
  assert.equal(tries.length, 2, "the refusal costs one extra request, not the turn");
  assert.ok(tries[0].thinking, "the first try asked for thinking");
  assert.equal(tries[1].thinking, undefined, "the retry drops it");

  const text = res.frames().map((f) => f.choices?.[0]?.delta?.content).filter(Boolean).join("");
  assert.equal(text, "no thinking here", "and the user gets a real answer instead of an error");
  assert.ok(
    !res.out.join("").includes("backend: anthropic error"),
    "no error text is streamed — the failed attempt never reached the client",
  );
  assert.equal(res.frames().at(-2)?.choices?.[0]?.finish_reason, "stop", "the retry's stop reason wins, not the failed attempt's");
}

// --- a failure AFTER output has shipped is not retried ---------------------------------------
{
  failMidStream = true;
  const before = seen.length;
  const res = await call({ model: "claude-test", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
  failMidStream = false;

  assert.equal(seen.length - before, 1, "no second request once the model's output is already on the wire — a retry would restart the answer on top of itself");
  assert.ok(res.out.join("").includes("backend: anthropic error"), "the caller is told it broke instead of being handed a doubled answer");
}

// --- no reasoning_effort: nothing changes ---------------------------------------------------
{
  const before = seen.length;
  await call({ model: "claude-test", tools: TOOLS, messages: [{ role: "user", content: "hi" }] });
  assert.equal(seen.length - before, 1, "no retry when there was nothing to retry without");
  assert.equal(seen.at(-1).thinking, undefined, "thinking stays off unless it was asked for");
  assert.equal(seen.at(-1).max_tokens, 8192, "and max_tokens is untouched");
}

// --- budgets scale with effort --------------------------------------------------------------
for (const [effort, budget] of [["low", 2048], ["medium", 8192]]) {
  await call({ model: "claude-test", messages: [{ role: "user", content: "hi" }], reasoning_effort: effort });
  assert.equal(seen.at(-1).thinking.budget_tokens, budget, `${effort} effort → ${budget} thinking tokens`);
  assert.ok(seen.at(-1).thinking.budget_tokens >= 1024, "never under Anthropic's floor");
}

srv.close();
console.log("anthropic-thinking: all checks passed");
