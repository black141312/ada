// Deterministic payload measurement: how many tokens ada actually puts on the wire per turn.
//
// End-to-end benchmarks can't measure context changes. The agent's step count varies 2-4x run to
// run, the whole transcript is re-sent every step, so input scales super-linearly with a number
// that is pure noise — measured 18,626 vs 72,227 input tokens on the same task, same prompt, same
// commit, with four lines of difference. This replaces the model with a scripted stub so the turn
// sequence is FIXED, and measures the only thing the context changes actually control: the size of
// each request body.
//
//   run:     node --import tsx test/payload-bench.mjs
//   compare: run it on both code versions and diff the totals
//
// Deliberately not an assert-style test — it prints numbers. Run it before and after a context
// change to see whether the change did anything.
//
// ponytail: chars/4 for the token estimate, same heuristic as compaction.ts. Exact byte counts are
// printed alongside; both arms use the same estimator so the comparison holds either way.

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const BASE = process.env.PAYLOAD_BASE || "17b8a64"; // fixed workspace, so the repo map is identical
const WT = join(tmpdir(), "ada-payload-bench-wt");

// The agent explores its cwd (repo map, project skills). That must be byte-identical across arms,
// or the workspace difference shows up as a payload difference. A detached worktree at a fixed
// commit guarantees it — the repo's own working tree is exactly what differs between arms.
function fixedWorkspace() {
  if (existsSync(WT)) {
    try {
      execSync(`git worktree remove --force "${WT}"`, { cwd: REPO, stdio: "ignore" });
    } catch {
      /* not registered */
    }
    rmSync(WT, { recursive: true, force: true });
  }
  mkdirSync(dirname(WT), { recursive: true });
  execSync(`git worktree add --detach "${WT}" ${BASE}`, { cwd: REPO, stdio: "ignore" });
  return WT;
}

// A fixed turn script. The stub ignores what the agent said and replays these in order, so both
// arms take exactly the same path: two big file reads and an answer, then a second user message
// with one more read and an answer.
//
// TWO sends is the point. A skill body has to survive its own tool loop, so scoping it to one
// request is invisible inside a single send() — which is all `ada -p` ever does. The cost it avoids
// lands on the turns of the NEXT message, and only a multi-send script can see that.
const SCRIPT = [
  // send 1 — routes to a skill
  { tool: "read_file", args: { path: "src/client/cli.ts" } },
  { tool: "read_file", args: { path: "src/client/tools.ts" } },
  { text: "Done." },
  // send 2 — the skill no longer applies
  { tool: "read_file", args: { path: "src/client/agent.ts" } },
  { text: "Listed." },
];

const SENDS = ["create a presentation for the project", "now count the lines in that file"];

const seen = [];
let step = 0;

const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ body, parsed: JSON.parse(body) });
    const s = SCRIPT[Math.min(step++, SCRIPT.length - 1)];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (s.tool) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: s.tool, arguments: JSON.stringify(s.args) } }] }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } else {
      send({ choices: [{ delta: { content: s.text }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => srv.listen(0, r));
const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

// Import the code under test from the REPO, then run with cwd = the fixed workspace.
const { Agent } = await import(pathToFileURL(join(REPO, "src", "client", "agent.ts")).href);
const { Session } = await import(pathToFileURL(join(REPO, "src", "client", "session.ts")).href);
const skills = await import(pathToFileURL(join(REPO, "src", "client", "skills.ts")).href);
const OpenAI = (await import("openai")).default;

process.env.ADA_TRUST_CWD = "1"; // match production: repo map + project skills on
process.chdir(fixedWorkspace());

// The CLI registers skills before constructing an Agent; without this the router has an empty
// registry, routeConfident() can never fire, and the skill-body change measures nothing.
skills.registerSkillTool(skills.loadSkills(true));

const client = new OpenAI({ apiKey: "x", baseURL });
const agent = new Agent({
  client,
  model: "m",
  session: Session.create(),
  onApprove: async () => "yes",
  autoApprove: true,
  project: true,
});

const sendBoundaries = [];
for (const msg of SENDS) {
  sendBoundaries.push(seen.length);
  // NOT quiet. send() gates skill routing and memory recall on `!ctrl.quiet`, and cli.ts sets
  // quiet from --json — so the JSON path (which every benchmark uses) silently runs with skills
  // and recall disabled. Measuring under quiet would measure a configuration nobody ships.
  await agent.send(msg, { onEvent() {} });
}

const est = (s) => Math.ceil(s.length / 4);
const rows = seen.map((r, i) => {
  const m = r.parsed.messages ?? [];
  const sys = m.filter((x) => x.role === "system").map((x) => String(x.content ?? "")).join("\n");
  return {
    turn: i + 1,
    send: sendBoundaries.filter((b) => i >= b).length,
    bytes: r.body.length,
    estTokens: est(r.body),
    msgs: m.length,
    tools: (r.parsed.tools ?? []).length,
    toolSchemaTokens: est(JSON.stringify(r.parsed.tools ?? [])),
    skillBody: /Follow its procedure/.test(sys),
  };
});

const tot = rows.reduce((a, r) => ({ bytes: a.bytes + r.bytes, estTokens: a.estTokens + r.estTokens }), { bytes: 0, estTokens: 0 });

console.log(`\nworkspace ${BASE} · ${rows.length} requests · trust on\n`);
console.log("send  turn   bytes    ~tokens   msgs  tools  toolSchema~  skillBody");
for (const r of rows) {
  console.log(
    `${String(r.send).padEnd(5)} ${String(r.turn).padEnd(6)} ${String(r.bytes).padEnd(8)} ${String(r.estTokens).padEnd(9)} ${String(r.msgs).padEnd(5)} ${String(r.tools).padEnd(6)} ${String(r.toolSchemaTokens).padEnd(12)} ${r.skillBody ? "YES" : "no"}`,
  );
}
console.log(`\nTOTAL  ${tot.bytes} bytes · ~${tot.estTokens} tokens sent across ${rows.length} requests`);
console.log(JSON.stringify({ total: tot, rows }));

srv.close();
process.exit(0);
