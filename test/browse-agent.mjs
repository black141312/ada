// The browser loop is delegated to a sub-agent on a cheap vision model, and the point of the whole
// arrangement is that the main model never sees a screenshot. This checks the two halves that make
// that true: the specialist really is restricted to `browser`, and it really runs on its own model.
//   run: node --import tsx test/browse-agent.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const seen = [];
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

const { registerBrowseTool, browseModel, BROWSE_DEFAULT_MODEL } = await import(pathToFileURL(resolve("src/client/browse.ts")).href);
const { toolByName } = await import(pathToFileURL(resolve("src/client/tools.ts")).href);
const OpenAI = (await import("openai")).default;
const client = new OpenAI({ apiKey: "x", baseURL });

// Default model: a vision model, and NOT whatever the user picked for coding.
assert.match(BROWSE_DEFAULT_MODEL, /sonnet/i, `browse should default to a Sonnet, got ${BROWSE_DEFAULT_MODEL}`);
process.env.ADA_BROWSE_MODEL = "cheap-model-1";
assert.equal(browseModel(), "cheap-model-1", "ADA_BROWSE_MODEL must win");

registerBrowseTool({ client, onApprove: async () => "yes" });
const browse = toolByName.get("browse");
assert.ok(browse, "browse should be registered");
assert.equal(browse.needsApproval, true, "browse drives a real browser — it must ask first");

const out = await browse.run({ goal: "open http://localhost:5173 and tell me if the header renders" });
assert.equal(out.isError, undefined, `browse errored: ${out.output}`);
assert.match(out.output, /done/, "browse should return the sub-agent's text");

const req = seen[seen.length - 1];
assert.equal(req.model, "cheap-model-1", `the browser loop must run on the browse model, got ${req.model}`);
const names = (req.tools ?? []).map((t) => t.function.name);
assert.deepEqual(names, ["browser"], `the browse agent must see exactly the browser tool, got ${names.join(", ")}`);

// A short goal must not be mistaken for small talk — that would strip the one tool it has.
seen.length = 0;
await browse.run({ goal: "click login" });
assert.deepEqual(
  ((seen[0] ?? {}).tools ?? []).map((t) => t.function.name),
  ["browser"],
  "a terse goal must still carry the browser tool",
);

assert.ok((await browse.run({ goal: "  " })).isError, "an empty goal should be an error, not a browser launch");

srv.close();
console.log("ok");
