// Reasoning, end to end: a fake OpenAI-compatible endpoint streams `reasoning_content` beside the
// answer, and the real Agent consumes it. Two consumers, two shapes:
//   - a caller with onEvent gets `reasoning` events, separate from `text`
//   - the plain REPL prints a "✻ Thinking…" block to stdout and nothing else
// In BOTH cases the thinking must stay out of the answer and out of the transcript — folding it in
// would put the model's scratch work in every later request.
//   run: node --import tsx test/reasoning-stream.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const THOUGHT = ["The user said hi.", " A greeting back is enough.\nNo tools needed."];
// Two lines on purpose: the markdown streamer is line-buffered, so a one-line answer would only
// reach stdout after the stream ends — and a thinking block left open would look fine anyway.
const ANSWER = ["Hello", " there!\n", "Anything else?"];

const srv = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    // Interleaved the way a real provider sends it: all thinking, then the answer.
    for (const t of THOUGHT) frame({ reasoning_content: t });
    for (const t of ANSWER) frame({ content: t });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

const { Agent } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);
const { Session } = await import(pathToFileURL(resolve("src/client/session.ts")).href);
const OpenAI = (await import("openai")).default;
const client = new OpenAI({ apiKey: "x", baseURL });

const newAgent = () =>
  new Agent({ client, model: "m", session: Session.create(), onApprove: async () => "yes", autoApprove: true, reasoning: "high" });

// --- 1. a structured consumer (the IDE / TUI path) ------------------------------------------
{
  const agent = newAgent();
  const reasoning = [];
  const text = [];
  let sawReasoningStart = false;
  const answer = await agent.send("hi", {
    onReasoningStart: () => (sawReasoningStart = true),
    onEvent: (e) => {
      if (e.type === "reasoning") reasoning.push(e.delta);
      if (e.type === "text") text.push(e.delta);
    },
  });

  assert.equal(reasoning.join(""), THOUGHT.join(""), "every reasoning delta is forwarded, in order");
  assert.equal(text.join(""), ANSWER.join(""), "and the answer arrives separately");
  assert.equal(answer, ANSWER.join(""), "send() returns the answer alone");
  assert.equal(sawReasoningStart, false, "onReasoningStart is for the stdout path only — onEvent callers drive their own UI");
  const transcript = JSON.stringify(agent.messages);
  assert.ok(transcript.includes("Hello there!"), "the answer is in the transcript"); // guards the next line from passing vacuously
  assert.ok(!transcript.includes("greeting back"), "but the thinking never is");
}

// --- 2. the plain REPL (stdout) -------------------------------------------------------------
{
  const agent = newAgent();
  const out = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => {
    out.push(typeof s === "string" ? s : s.toString());
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") cb();
    return true;
  };
  let spinnerStopped = 0;
  let replyStarted = 0;
  let answer;
  try {
    answer = await agent.send("hi", {
      onReasoningStart: () => spinnerStopped++,
      onReplyStart: () => replyStarted++,
    });
  } finally {
    process.stdout.write = real;
  }
  const printed = out.join("");
  const plain = printed.replace(/\x1b\[[0-9;]*m/g, "");

  assert.equal(spinnerStopped, 1, "the spinner is cleared once, when thinking starts");
  assert.equal(replyStarted, 1, "and the ◆ bullet still waits for the answer");
  assert.ok(printed.indexOf("✻ Thinking…") >= 0, "the block is headed the way Claude heads it");
  assert.ok(plain.includes("A greeting back is enough."), "the thought itself is printed");
  assert.ok(printed.includes("\x1b[2;3m"), "dim + italic, so it reads as aside rather than answer");
  assert.ok(plain.includes("\n  No tools needed."), "continuation lines are indented into a block");
  assert.ok(
    printed.indexOf("✻ Thinking…") < printed.indexOf("Hello"),
    "thinking is closed before the answer, never interleaved with it",
  );
  assert.ok(
    plain.includes("No tools needed.\n\nHello"),
    "and closed AT the answer's first token — a block left open runs the answer straight onto the last thought",
  );
  assert.equal(answer, ANSWER.join(""), "and the answer is still just the answer");
}

// --- 3. quiet callers (sub-agents) stay silent ----------------------------------------------
{
  const agent = newAgent();
  const out = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => (out.push(String(s)), true);
  try {
    await agent.send("hi", { quiet: true });
  } finally {
    process.stdout.write = real;
  }
  assert.ok(!out.join("").includes("Thinking"), "a quiet sub-agent prints no thinking");
}

srv.close();
console.log("reasoning-stream: all checks passed");
