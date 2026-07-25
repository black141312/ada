// What actually goes on the wire per turn. Drives the real Agent against a fake OpenAI-compatible
// endpoint and inspects the recorded request: small talk must carry no tools and no repo map, while
// a genuine request must carry both (plus the document tools when it asks for a document).
//   run: node --import tsx test/request-shape.mjs
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
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

const { Agent } = await import(
  pathToFileURL(resolve("src/client/agent.ts")).href
);
const { Session } = await import(
  pathToFileURL(resolve("src/client/session.ts")).href
);
const OpenAI = (await import("openai")).default;
const client = new OpenAI({ apiKey: "x", baseURL });

async function shapeOf(message) {
  const agent = new Agent({
    client,
    model: "m",
    session: Session.create(),
    onApprove: async () => "yes",
    autoApprove: true,
    project: true,
  });
  await agent.send(message, { quiet: true, onEvent() {} });
  const req = seen[seen.length - 1];
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  return {
    tools: (req.tools ?? []).length,
    hasMap: /Project map/.test(system),
    names: (req.tools ?? []).map((t) => t.function.name),
  };
}

// Small talk: nothing but the base prompt — no tools, no repo map.
for (const msg of ["hi", "thanks", "ok"]) {
  const s = await shapeOf(msg);
  assert.equal(
    s.tools,
    0,
    `"${msg}" should advertise no tools, got ${s.tools}`,
  );
  assert.equal(s.hasMap, false, `"${msg}" should not carry the repo map`);
}

// A real request: full core toolset + the repo map, but not the document generators.
const code = await shapeOf("what does src/index.js do?");
assert.ok(
  code.tools >= 10,
  `a code request should carry the core tools, got ${code.tools}`,
);
assert.equal(code.hasMap, true, "a code request should carry the repo map");
assert.ok(
  !code.names.includes("generate_pptx"),
  "document tools should stay out of a plain code request",
);

// Asking for a document adds the generators on top.
const deck = await shapeOf("make me a deck about this project");
assert.ok(
  deck.names.includes("generate_pptx"),
  "a deck request must advertise generate_pptx",
);
assert.ok(
  deck.tools > code.tools,
  "a deck request should carry more tools than a code request",
);
assert.equal(deck.hasMap, true, "a deck request should carry the repo map");

// Each lazy group has its own trigger: one kind of request must not drag in the others' schemas.
const nb = await shapeOf("fix the broken cell in analysis.ipynb");
assert.ok(nb.names.includes("notebook_edit"), "a notebook request must advertise notebook_edit");
assert.ok(!nb.names.includes("generate_pptx"), "a notebook request must not advertise generate_pptx");
assert.ok(!nb.names.includes("browser"), "a notebook request must not advertise browser");

const ui = await shapeOf("screenshot localhost:5173 and check the console");
assert.ok(ui.names.includes("browser"), "a UI request must advertise browser");
assert.ok(!ui.names.includes("notebook_edit"), "a UI request must not advertise notebook_edit");
assert.ok(!ui.names.includes("generate_docx"), "a UI request must not advertise generate_docx");

assert.ok(!deck.names.includes("browser") && !deck.names.includes("notebook_edit"), "a deck request must not advertise the browser/notebook tools");

// git is core, not lazy — it rides along with any real request but never with small talk.
assert.ok(code.names.includes("git"), "a code request should carry the git tool");

srv.close();
console.log("ok");
