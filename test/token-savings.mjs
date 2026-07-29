// The two pure helpers on the token/cost path. Both fail silently if broken — a missing
// cache_control just costs money on every turn, and a head-only clip just hides the answer —
// so neither shows up as a crash. Guard them here.
//   run: node --import tsx test/token-savings.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { clip } = await import(pathToFileURL(resolve("src/client/tools.ts")).href);
const { markLastBlockCacheable } = await import(
  pathToFileURL(resolve("src/server/providers/anthropic.ts")).href
);

// --- clip: keeps BOTH ends -------------------------------------------------
const long = `${"H".repeat(500)}${"m".repeat(9000)}${"T".repeat(500)}`;
const clipped = clip(long, 300);

assert.ok(clipped.startsWith("H"), "clip dropped the head");
assert.ok(clipped.endsWith("T"), "clip dropped the tail — the verdict lives here");
assert.ok(clipped.includes("truncated"), "clip must say how much it dropped");
assert.ok(clipped.length < long.length, "clip did not actually shrink the output");
assert.equal(clip("short", 300), "short", "clip must not touch under-limit output");

// --- markLastBlockCacheable: the breakpoint lands on the last block --------
const cc = { type: "ephemeral" };

// string content is normalized to blocks, because cache_control can't attach to a bare string
const strMsgs = [{ role: "user", content: "hello" }];
markLastBlockCacheable(strMsgs, cc);
assert.ok(Array.isArray(strMsgs[0].content), "string content was not normalized to blocks");
assert.deepEqual(strMsgs[0].content[0].cache_control, cc, "breakpoint missing on normalized block");
assert.equal(strMsgs[0].content[0].text, "hello", "normalizing lost the text");

// with several messages, only the LAST block of the LAST message is marked
const many = [
  { role: "user", content: [{ type: "text", text: "a" }] },
  { role: "assistant", content: [{ type: "text", text: "b" }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "c" }] },
];
markLastBlockCacheable(many, cc);
assert.equal(many[0].content[0].cache_control, undefined, "marked a block that isn't the prefix end");
assert.equal(many[1].content[0].cache_control, undefined, "marked a block that isn't the prefix end");
assert.equal(many[2].content[0].cache_control, undefined, "marked the wrong block in the last message");
assert.deepEqual(many[2].content[1].cache_control, cc, "breakpoint missing on the final block");

// degenerate inputs must not throw — an empty turn would otherwise take down every request
assert.doesNotThrow(() => markLastBlockCacheable([], cc));
assert.doesNotThrow(() => markLastBlockCacheable([{ role: "user", content: [] }], cc));

// --- markCacheable: the OpenAI-compatible path (OpenRouter etc.) -----------
const { markCacheable } = await import(pathToFileURL(resolve("src/server/providers/openai-compat.ts")).href);
const cached = (m) => JSON.stringify(m).includes("cache_control");

// Non-Claude models must come back BYTE-IDENTICAL. They cache automatically or not at all, and an
// unexpected field inside a content part is a 400 from several providers.
for (const model of ["gpt-5.5", "moonshotai/kimi-k2.7-code", "deepseek/deepseek-v3.2", "gemini-3.5-flash"]) {
  const input = { model, messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(markCacheable(input), input, `${model} must pass through untouched`);
}

// Claude, by either naming convention, gets a breakpoint.
for (const model of ["anthropic/claude-opus-4.7", "claude-opus-4-7"]) {
  const out = markCacheable({ model, messages: [{ role: "user", content: "hi" }] });
  assert.ok(cached(out), `${model} should be marked cacheable`);
  assert.equal(out.messages[0].content[0].text, "hi", "normalising to blocks lost the text");
}

// The marker lands on the last user/assistant turn — never on a tool message, whose content shape
// maps to tool_result upstream.
const loop = markCacheable({
  model: "anthropic/claude-opus-4.7",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    { role: "assistant", content: "working", tool_calls: [{ id: "t1", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "a\nb" },
    { role: "system", content: "per-turn extras" },
  ],
});
assert.ok(!cached(loop.messages[0]), "system prompt must not be marked (it changes every turn)");
assert.ok(!cached(loop.messages[3]), "tool messages must never be marked");
assert.ok(!cached(loop.messages[4]), "trailing system extras must not be marked");
assert.ok(cached(loop.messages[2]), "the last assistant turn should carry the breakpoint");

// Degenerate shapes must not throw — this runs on every single request.
for (const messages of [[], [{ role: "system", content: "only system" }], [{ role: "assistant", content: null, tool_calls: [] }]]) {
  assert.doesNotThrow(() => markCacheable({ model: "anthropic/claude-opus-4.7", messages }));
}

console.log("token-savings OK");
