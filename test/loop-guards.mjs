// Loop hygiene: repeat-call nudge, tool deadline, output spill. Run: npx tsx test/loop-guards.mjs
import assert from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADA_TOOL_TIMEOUT_MS = "60"; // read at module load — must be set before the import below

const { repeatReminder, safeRun } = await import("../src/client/agent.ts");
const { spillIfHuge } = await import("../src/client/tools.ts");

// 1. repeat nudge: silent for the first two, fires from the third identical call, never for a different one
const counts = new Map();
const call = (name, args) => repeatReminder(counts, name, args);
assert.equal(call("bash", { command: "ls" }), "");
assert.equal(call("bash", { command: "ls" }), "");
assert.match(call("bash", { command: "ls" }), /call 3 to bash/);
assert.match(call("bash", { command: "ls" }), /call 4 to bash/);
assert.equal(call("bash", { command: "pwd" }), "", "different args are a different call");
assert.equal(call("read_file", { command: "ls" }), "", "same args, different tool");

// 2. deadline: a tool that never resolves comes back as an error instead of hanging the turn
const hung = { name: "hangs", run: () => new Promise(() => {}) };
const t0 = Date.now();
const res = await safeRun(hung, {});
assert.equal(res.isError, true);
assert.match(res.output, /no result after/);
assert(Date.now() - t0 < 5000, "should give up at the deadline, not wait");

// a tool that resolves normally is untouched
assert.deepEqual(await safeRun({ name: "ok", run: async () => ({ output: "fine" }) }, {}), { output: "fine" });

// 3. spill: oversized output keeps head+tail inline and writes the whole thing where it can be read back
process.chdir(mkdtempSync(join(tmpdir(), "ada-spill-")));
const huge = `HEAD${"x".repeat(200_000)}TAIL`;
const out = spillIfHuge(huge);
assert(out.length < huge.length / 2, "inline copy is bounded");
assert(out.startsWith("HEAD") && out.includes("TAIL"), "both ends survive");
const path = out.match(/\[full output: (.+)\]/)?.[1];
assert(path, "points at the spill file");
assert.equal(readFileSync(join(process.cwd(), path), "utf8"), huge, "spill file holds the full text");
assert.equal(spillIfHuge("small"), "small", "small output is passed through untouched");

// yesterday's spills are swept, today's are kept
const dir = join(process.cwd(), ".ada", "tmp");
writeFileSync(join(dir, "out-1000000000000-1.txt"), "stale");
const fresh = spillIfHuge(huge).match(/\[full output: (.+)\]/)[1];
const left = readdirSync(dir);
assert(!left.includes("out-1000000000000-1.txt"), "stale spill removed");
assert(left.includes(fresh.split(/[\\/]/).pop()), "fresh spill kept");

console.log("loop-guards: ok");
