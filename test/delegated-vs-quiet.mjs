// `quiet` suppresses output. `delegated` skips skill routing and memory recall. They are different
// things, and they used to be the same flag — which meant `ada -p "..." --json` (quiet, because the
// caller wants clean JSON on stdout) silently ran with skills and recall disabled. Every scripted
// run and every benchmark went through that path, so the whole skill system was measured as absent.
//
// This asserts the split holds: an output format must never change what the agent does.
//   run: node --import tsx test/delegated-vs-quiet.mjs
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
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

const { Agent } = await import(pathToFileURL(resolve("src/client/agent.ts")).href);
const { Session } = await import(pathToFileURL(resolve("src/client/session.ts")).href);
const skills = await import(pathToFileURL(resolve("src/client/skills.ts")).href);
const OpenAI = (await import("openai")).default;

// Without this the router has an empty registry and nothing can route — the test would pass for
// the wrong reason.
skills.registerSkillTool(skills.loadSkills(true));

// A prompt that routes confidently, so "no skill body" means the gate suppressed it rather than
// nothing having matched.
const PROMPT = "create a presentation for the project";
assert.ok(skills.routeConfident(PROMPT), `test premise broken: "${PROMPT}" no longer routes to a skill`);

const client = new OpenAI({ apiKey: "x", baseURL });

async function skillBodySentFor(ctrl) {
  seen.length = 0;
  const agent = new Agent({
    client,
    model: "m",
    session: Session.create(),
    onApprove: async () => "yes",
    autoApprove: true,
    project: false,
  });
  await agent.send(PROMPT, ctrl);
  const sys = (seen.at(-1)?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n");
  return /Follow its procedure/.test(sys);
}

// The regression: quiet is an OUTPUT flag. It must not disable routing.
assert.equal(await skillBodySentFor({ quiet: true, onEvent() {} }), true, "quiet:true must still route skills — that was the --json bug");

// Delegated turns come from a parent agent that already scoped the task; routing is skipped there.
assert.equal(await skillBodySentFor({ quiet: true, delegated: true, onEvent() {} }), false, "delegated:true must skip skill routing");

// And the default path routes, obviously.
assert.equal(await skillBodySentFor({ onEvent() {} }), true, "a plain user turn must route skills");

srv.close();
console.log("ok");
process.exit(0);
