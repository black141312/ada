// Tool screenshots ride into context as marked user messages, and only the newest 2 survive —
// a game loop takes one per move and would otherwise drown the context.
// run: node --import tsx test/tool-images.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { pruneToolImages, TOOL_IMAGE_NOTE } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);

const img = (n) => ({
  role: "user",
  content: [
    { type: "text", text: `${TOOL_IMAGE_NOTE} (from browser)` },
    { type: "image_url", image_url: { url: `data:image/png;base64,shot${n}` } },
  ],
});
// a user-PASTED image must never be pruned — it lacks the marker
const pasted = { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:image/png;base64,mine" } }] };

const messages = [
  { role: "user", content: "play 2048" },
  pasted,
  img(1),
  { role: "assistant", content: "moving left" },
  img(2),
  img(3),
];
pruneToolImages(messages);

const hasImage = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url");
assert.ok(!hasImage(messages[2]), "oldest tool image should be pruned");
assert.equal(messages[2].content, `${TOOL_IMAGE_NOTE} [old screenshot removed]`);
assert.ok(hasImage(messages[4]) && hasImage(messages[5]), "newest 2 tool images must survive");
assert.ok(hasImage(messages[1]), "user-pasted image must survive");
assert.equal(messages[0].content, "play 2048", "plain messages untouched");

// idempotent: pruning again changes nothing
const snapshot = JSON.stringify(messages);
pruneToolImages(messages);
assert.equal(JSON.stringify(messages), snapshot);

console.log("tool-images: ok");
