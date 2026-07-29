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

console.log("token-savings OK");
