// Offline self-check: tools, session persistence, and routing. No network, no API key.
// Run with: npm run selfcheck

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, isContextOverflowError, planCut } from "./client/compaction.ts";
import { loadImage } from "./client/image.ts";
import { expandPrompt } from "./client/prompts.ts";
import { MarkdownStreamer, highlight, renderEditDiff } from "./client/render.ts";
import { Session, list } from "./client/session.ts";
import { loadSkills, registerSkillTool, routeConfident } from "./client/skills.ts";
import { Agent, describeCall, parseTextToolCalls, permPhrase, readIntegrationDocs, soleIntegration, writeProjectSkills } from "./client/agent.ts";
import { userBar } from "./client/tui.ts";
import { configuredServers, listConnectors, loadMcpServers } from "./client/mcp.ts";
import { confidentSkill, rankSkills } from "./client/skill-router.ts";
import { getDiagnostics } from "./client/lsp.ts";
import { snapshot } from "./client/snapshot.ts";
import { renderJobs, startJob } from "./client/background.ts";
import { askOptions, formatFile, htmlToText, isDestructive, registerTool, setAsker, toolByName } from "./client/tools.ts";
import * as checkpoint from "./client/checkpoint.ts";
import { renderTodos, setTodos } from "./client/todos.ts";
import { deleteCredential, getCredential, setCredential } from "./server/credentials.ts";
import { isAllowed } from "./server/identity.ts";
import { popularModels } from "./client/models.ts";
import { route } from "./server/router.ts";
import { providerStatus } from "./server/config.ts";

function tool(name: string) {
  const t = toolByName.get(name);
  if (!t) throw new Error(`missing tool: ${name}`);
  return t;
}

async function main(): Promise<void> {
  // --- tools: write -> edit -> read round-trip ---
  const dir = join(tmpdir(), `ada-selfcheck-${Date.now()}`);
  const file = join(dir, "a.txt");

  let r = await tool("write_file").run({ path: file, content: "hello world" });
  assert.ok(!r.isError, r.output);
  r = await tool("edit_file").run({ path: file, old_text: "world", new_text: "ada" });
  assert.ok(!r.isError, r.output);
  r = await tool("read_file").run({ path: file });
  assert.equal(r.output, "hello ada");

  // ambiguous edit must error
  await tool("write_file").run({ path: file, content: "x x" });
  r = await tool("edit_file").run({ path: file, old_text: "x", new_text: "y" });
  assert.ok(r.isError, "ambiguous edit should error");

  // missing read must error
  r = await tool("read_file").run({ path: join(dir, "nope.txt") });
  assert.ok(r.isError, "missing read should error");

  // bash
  r = await tool("bash").run({ command: "echo hi" });
  assert.ok(r.output.includes("hi"), r.output);

  // --- browser: a11y tree serializer (pure, no browser needed) ---
  const { formatAxTree } = await import("./client/browser.ts");
  const ax = formatAxTree([
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "T" }, childIds: ["2", "3", "4"] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Do thing" }, backendDOMNodeId: 10 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Name" }, value: { value: "bob" }, backendDOMNodeId: 11 },
    { nodeId: "4", parentId: "1", ignored: true, childIds: ["5"] },
    { nodeId: "5", parentId: "4", role: { value: "StaticText" }, name: { value: "hi" } },
  ]);
  assert.ok(ax.text.includes('button "Do thing" [ref_1]'), ax.text);
  assert.ok(ax.text.includes('textbox "Name" = "bob" [ref_2]'), ax.text);
  assert.ok(ax.text.includes('StaticText "hi"'), ax.text); // ignored wrapper skipped, child kept
  assert.equal(ax.refs.get("ref_1"), 10);
  assert.equal(ax.refs.get("ref_2"), 11);

  // grep / ls / glob
  await tool("write_file").run({ path: join(dir, "hello.txt"), content: "alpha\nNEEDLE here\nbeta" });
  const g = await tool("grep").run({ path: dir, pattern: "NEEDLE" });
  assert.ok(g.output.includes("NEEDLE"), g.output);
  const l = await tool("ls").run({ path: dir });
  assert.ok(l.output.includes("hello.txt"), l.output);
  const gl = await tool("glob").run({ pattern: "src/selfcheck.ts" });
  assert.ok(gl.output.includes("selfcheck.ts"), gl.output);

  // read offset/limit
  await tool("write_file").run({ path: join(dir, "lines.txt"), content: "L1\nL2\nL3\nL4" });
  const ol = await tool("read_file").run({ path: join(dir, "lines.txt"), offset: 2, limit: 2 });
  assert.equal(ol.output, "L2\nL3");

  // multi-edit
  await tool("write_file").run({ path: join(dir, "m.txt"), content: "aaa bbb ccc" });
  r = await tool("edit_file").run({
    path: join(dir, "m.txt"),
    edits: [
      { old_text: "aaa", new_text: "AAA" },
      { old_text: "ccc", new_text: "CCC" },
    ],
  });
  assert.ok(!r.isError, r.output);
  r = await tool("read_file").run({ path: join(dir, "m.txt") });
  assert.equal(r.output, "AAA bbb CCC");

  // CRLF preservation: file uses \r\n, edit's old_text uses \n
  const crlf = join(dir, "crlf.txt");
  await tool("write_file").run({ path: crlf, content: "one\r\ntwo\r\nthree" });
  r = await tool("edit_file").run({ path: crlf, old_text: "two", new_text: "TWO" });
  assert.ok(!r.isError, r.output);
  r = await tool("read_file").run({ path: crlf });
  assert.ok(r.output.includes("\r\n") && r.output.includes("TWO"), JSON.stringify(r.output));

  // generate_pptx: structured slides -> valid OPC zip with all required parts
  const png = join(dir, "dot.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const pptxPath = join(dir, "deck.pptx");
  r = await tool("generate_pptx").run({
    path: pptxPath,
    title: "Selfcheck deck",
    slides: [
      { title: "ada", subtitle: "a deck from the selfcheck" },
      { title: "Bullets", bullets: ["one", { text: "nested", level: 1 }, "two & <escaped>"], notes: "speaker notes here" },
      { title: "Image", image: png },
    ],
  });
  assert.ok(!r.isError, r.output);
  const pptxBytes = readFileSync(pptxPath);
  assert.equal(pptxBytes.readUInt32LE(0), 0x04034b50, "pptx must start with a zip local-file header");
  for (const part of ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide3.xml", "ppt/notesSlides/notesSlide2.xml", "ppt/media/image1.png", "ppt/theme/theme1.xml"])
    assert.ok(pptxBytes.includes(part), `pptx missing part: ${part}`);
  r = await tool("generate_pptx").run({ path: join(dir, "empty.pptx"), slides: [] });
  assert.ok(r.isError, "empty slides should error");
  r = await tool("generate_pptx").run({ path: join(dir, "deck.txt"), slides: [{ title: "x" }] });
  assert.ok(r.isError, "non-.pptx path should error");

  rmSync(dir, { recursive: true, force: true });

  // --- session append -> load round-trip ---
  const s = Session.create();
  s.append({ role: "user", content: "hello" });
  s.append({ role: "assistant", content: "hi there" });
  const loaded = s.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]!.content, "hello");
  rmSync(s.file, { force: true });

  // --- branching: fork seeds messages, records parent, load skips __meta ---
  const parent = Session.create();
  parent.append({ role: "user", content: "p1" });
  const branch = Session.fork(parent.file, [
    { role: "user", content: "p1" },
    { role: "assistant", content: "a1" },
  ]);
  const bl = branch.load();
  assert.equal(bl.length, 2, "fork load skips the __meta line");
  assert.equal(bl[0]!.content, "p1");
  const bm = list().find((m) => m.file === branch.file);
  assert.ok(bm?.parent === parent.file, "branch records its parent");
  rmSync(parent.file, { force: true });
  rmSync(branch.file, { force: true });

  // --- resume: a session's on-disk history seeds a fresh Agent's context (no live model needed) ---
  {
    const s = Session.create();
    s.append({ role: "user", content: "remember: the secret word is PINEAPPLE97" });
    s.append({ role: "assistant", content: "got it" });
    const history = s.load() as never[];
    const bare = new Agent({ client: {} as never, model: "x", session: Session.create(), onApprove: async () => "yes" });
    const resumed = new Agent({ client: {} as never, model: "x", session: s, onApprove: async () => "yes", history });
    assert.ok(resumed.contextTokens() > bare.contextTokens(), "resuming with history seeds more context than a bare session");
    rmSync(s.file, { force: true });
  }

  // --- router prefix mapping ---
  assert.equal(route("gpt-4o"), "openai");
  assert.equal(route("o3-mini"), "openai");
  assert.equal(route("claude-opus-4-8"), "anthropic");
  assert.equal(route("gemini-2.5-pro"), "google");
  assert.equal(route("mistral-large-latest"), "mistral");
  assert.equal(route("grok-2"), "xai");
  assert.equal(route("deepseek-chat"), "deepseek");
  assert.equal(route("qwen-max"), "dashscope");
  assert.equal(route("qwq-32b"), "dashscope");
  assert.equal(route("qwen/qwen-2.5-72b-instruct"), "openrouter"); // namespaced id stays on OpenRouter
  assert.equal(route("gemma4:latest"), "ollama"); // local Ollama "model:tag"
  assert.equal(route("mistralai/mistral-7b:free"), "openrouter"); // slash wins over colon
  assert.equal(route("meta-llama/llama-3.1-70b"), "openrouter");
  assert.equal(route("anything", "mistral"), "mistral");

  // --- compaction ---
  assert.ok(estimateTokens([{ role: "user", content: "hello" }] as never) > 0);
  assert.ok(isContextOverflowError(new Error("maximum context length exceeded")));
  assert.ok(!isContextOverflowError(new Error("invalid api key")));
  const convo = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "out" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];
  const plan = planCut(convo as never, 2);
  assert.ok(plan, "should plan a cut");
  assert.equal(plan!.system!.role, "system");
  assert.equal(plan!.tail[0]!.role, "user"); // tail starts on a user boundary — tool pairs never split

  // --- rendering ---
  const diff = renderEditDiff("f.ts", "old line", "new line");
  assert.ok(diff.includes("old line") && diff.includes("new line"), diff);
  const ms = new MarkdownStreamer();
  const rendered = ms.push("# Title\n- item\n") + ms.end();
  assert.ok(rendered.includes("Title") && rendered.includes("item"), rendered);
  const hl = highlight('const x = "hi" // c');
  assert.ok(hl.includes("\x1b[") && hl.includes("const"), hl); // keywords/strings/comments colored

  // --- prompt templates ---
  const pm = new Map([["fix", "Fix $1 carefully. All: $ARGUMENTS"]]);
  assert.equal(expandPrompt(pm, "/fix foo.ts it crashes"), "Fix foo.ts carefully. All: foo.ts it crashes");
  assert.equal(expandPrompt(pm, "/unknown x"), null);
  assert.equal(expandPrompt(pm, "hello"), null);

  // --- extensibility: dynamic tool registration + skills ---
  registerTool({
    name: "__demo",
    description: "demo",
    parameters: { type: "object", properties: {} },
    needsApproval: false,
    async run() {
      return { output: "ok" };
    },
  });
  assert.ok(toolByName.get("__demo"), "registerTool adds a dynamic tool");
  registerSkillTool([{ name: "demo", description: "d", path: "nope" }]);
  assert.ok(toolByName.get("use_skill"), "registerSkillTool exposes use_skill");

  // --- credential store round-trip ---
  await setCredential("__selfcheck", { type: "api_key", key: "sk-test" });
  assert.equal(getCredential("__selfcheck")?.key, "sk-test");
  await deleteCredential("__selfcheck");
  assert.equal(getCredential("__selfcheck"), undefined);

  // --- multimodal: image file → data url ---
  const imgPath = join(tmpdir(), `ada-img-${Date.now()}.png`);
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const img = loadImage(imgPath);
  assert.ok(img && img.dataUrl.startsWith("data:image/png;base64,"), "loadImage → png data url");
  rmSync(imgPath, { force: true });

  // --- checkpoint undo round-trip ---
  const cpFile = join(tmpdir(), `ada-cp-${Date.now()}.txt`);
  writeFileSync(cpFile, "v1");
  checkpoint.record(cpFile);
  writeFileSync(cpFile, "v2");
  checkpoint.undoAll();
  assert.equal(readFileSync(cpFile, "utf8"), "v1", "undo restores the original content");
  rmSync(cpFile, { force: true });

  // --- todos + destructive detection ---
  setTodos([{ text: "alpha", status: "done" }, { text: "beta", status: "todo" }]);
  assert.ok(renderTodos().includes("alpha") && renderTodos().includes("beta"), "todos render");
  assert.ok(isDestructive("rm -rf /tmp/x"), "rm -rf is destructive");
  assert.ok(!isDestructive("ls -la"), "ls is not destructive");

  // --- web_fetch HTML→text + tools registered ---
  const ht = htmlToText("<h1>Hi</h1><p>a &amp; b</p><script>x()</script><ul><li>one</li></ul>");
  assert.ok(/Hi/.test(ht) && /a & b/.test(ht) && /- one/.test(ht) && !/x\(\)/.test(ht), "htmlToText strips tags/scripts, decodes entities");
  assert.ok(toolByName.has("web_fetch") && toolByName.has("web_search"), "web tools registered");
  assert.equal(formatFile(join(tmpdir(), "x.go")), false, "formatFile is a safe no-op when untrusted/no formatter (never throws)");
  assert.ok(toolByName.has("lsp_diagnostics"), "lsp_diagnostics tool registered");
  assert.deepEqual(await getDiagnostics(join(tmpdir(), "x.ts")), [], "getDiagnostics no-ops when untrusted/no server (never throws)");
  const bashRun = await toolByName.get("bash")!.run({ command: "echo pty-probe-123" });
  assert.ok(/pty-probe-123/.test(bashRun.output) && /exit 0/.test(bashRun.output), `bash runs a command (PTY): ${bashRun.output.slice(0, 60)}`);

  // --- apply_patch: create → update → delete across files ---
  const ap = toolByName.get("apply_patch")!;
  const apDir = join(tmpdir(), `ada-ap-${process.pid}`);
  mkdirSync(apDir, { recursive: true });
  const apFile = join(apDir, "a.txt");
  assert.ok(!(await ap.run({ files: [{ path: apFile, action: "create", content: "hello\n" }] })).isError && existsSync(apFile), "apply_patch create");
  await ap.run({ files: [{ path: apFile, action: "update", edits: [{ old_text: "hello", new_text: "world" }] }] });
  assert.ok(/world/.test(readFileSync(apFile, "utf8")), "apply_patch update");
  await ap.run({ files: [{ path: apFile, action: "delete" }] });
  assert.ok(!existsSync(apFile), "apply_patch delete");
  rmSync(apDir, { recursive: true, force: true });

  // --- ask_user via a stub asker ---
  const askTool = toolByName.get("ask_user")!;
  setAsker(async (_q, opts) => (opts ? `${opts[0]!.label}|${opts[0]!.description}` : "the-answer"));
  assert.ok(/the-answer/.test((await askTool.run({ question: "?" })).output), "ask_user returns the answer");
  assert.ok(/picked-A/.test((await askTool.run({ question: "?", options: ["picked-A", "B"] })).output), "ask_user with options");
  // Options may carry a description, and a bare string still has to survive alongside them.
  assert.ok(
    /picked-A\|what it means/.test((await askTool.run({ question: "?", options: [{ label: "picked-A", description: "what it means" }, "B"] })).output),
    "ask_user options carry descriptions",
  );
  assert.equal(askOptions(["a", { label: "b", description: "d" }, { description: "no label" }, 3])?.length, 3, "askOptions drops entries with no label");
  assert.equal(askOptions([]), undefined, "askOptions treats an empty list as no options");
  setAsker(null);
  assert.equal((await askTool.run({ question: "?" })).isError, true, "ask_user errors when no asker is installed");

  // --- grep still works (rg fast path falls back to the JS scan when rg is absent) ---
  assert.ok(/tools\.ts/.test((await toolByName.get("grep")!.run({ pattern: "export const tools", path: "src/client" })).output), "grep finds matches");

  // --- workspace snapshot returns a git tree SHA (or null outside a repo); never throws ---
  const snap = snapshot();
  assert.ok(snap === null || /^[0-9a-f]{40}$/.test(snap), "snapshot returns a tree SHA");

  // --- approval context: readable call descriptions + plain-words permission phrases ---
  assert.equal(describeCall("bash", { command: 'dir "C:\\x" /b' }).detail, 'dir "C:\\x" /b', "bash → shows the command, not JSON");
  assert.equal(describeCall("read_file", { path: "a.ts" }).label, "read", "read_file → 'read'");
  assert.equal(describeCall("merchant__list_products", {}).label, "merchant", "MCP tool → connector name as label");
  assert.ok(permPhrase("bash", true).startsWith("⚠"), "destructive bash phrase is flagged");
  assert.equal(permPhrase("write_file", false), "create or modify files on disk", "write phrase");
  assert.ok(permPhrase("merchant__x", false).includes("connector"), "MCP phrase mentions the connector");

  // --- browser approval rendering ---
  assert.equal(describeCall("browser", { action: "click", ref: "ref_2" }).detail, "click ref_2");
  assert.ok(permPhrase("browser", true).toLowerCase().includes("enter"), "press-Enter phrase should warn about submitting");
  assert.ok(!permPhrase("browser", false).startsWith("run the"), "browser needs its own perm phrase");

  // --- baked offline catalog seeds pricing/limits (no network) ---
  {
    const { priceOf, contextOf, catalogSize, catalogText } = await import("./client/models-dev.ts");
    assert.ok(catalogSize() > 100, `catalog seeded from catalog.json (${catalogSize()} models)`);
    const op = priceOf("claude-opus-4-8");
    assert.ok(op && op[0] > 0 && op[1] > 0, "priceOf resolves a baked model offline");
    assert.ok((contextOf("claude-opus-4-8") ?? 0) >= 200000, "contextOf resolves a baked model offline");
    assert.ok(/anthropic/.test(catalogText()) && /openai/.test(catalogText()) && /cloudflare/.test(catalogText()), "catalogText lists the popular providers");
    assert.ok(/claude-opus-4-8/.test(catalogText("anthropic")), "catalogText <provider> lists its models");
  }

  // --- reading the paid-through date out of a provider payload ---
  {
    const { paidThroughOf } = await import("./server/kelviq.ts");
    const ms = Date.UTC(2027, 0, 15);
    assert.equal(paidThroughOf({ currentPeriodEnd: ms }), ms, "milliseconds pass through");
    assert.equal(paidThroughOf({ current_period_end: Math.floor(ms / 1000) }), ms, "seconds are scaled up");
    assert.equal(paidThroughOf({ expiresAt: "2027-01-15T00:00:00.000Z" }), ms, "an ISO string parses");
    // Anything unrecognised must yield null — which means "never expires", i.e. today's behaviour.
    // Guessing wrong here would cut off a paying customer, so the failure has to be the safe way.
    assert.equal(paidThroughOf({}), null, "no date means no expiry");
    assert.equal(paidThroughOf({ currentPeriodEnd: "not a date" }), null, "garbage means no expiry");
    assert.equal(paidThroughOf({ periodEnd: Number.NaN }), null, "NaN means no expiry");
  }

  // --- a paid plan must lapse on its own, not only when a webhook says so ---
  {
    const { effectivePlan, PLANS } = await import("./server/plans.ts");
    const now = Date.UTC(2026, 7, 3, 12);
    const p = (over: Record<string, unknown>) =>
      ({ user: "u", plan: "pro", status: "active", periodStart: null, paidThrough: null, ...over }) as never;

    // null = never expires. Plans granted by hand must not die because nobody wrote a date —
    // every existing row in production has a null here.
    assert.equal(effectivePlan(p({}), now).name, "pro", "no paid-through date means it never lapses");

    assert.equal(effectivePlan(p({ paidThrough: now + 86_400_000 }), now).name, "pro", "paid through tomorrow is still pro");
    // THE POINT: without this, the only thing that ever revokes a plan is a cancellation webhook
    // being delivered AND processed. A missed one grants a paid tier forever.
    assert.equal(effectivePlan(p({ paidThrough: now - 1 }), now).name, "free", "one ms past the paid period is free");
    assert.equal(effectivePlan(p({ paidThrough: now }), now).name, "free", "the boundary itself is over");

    // A lapsed plan drops to free QUOTAS too, not just the label — otherwise it keeps the paid cap.
    assert.equal(effectivePlan(p({ paidThrough: now - 1 }), now).monthlyTokens, PLANS.free.monthlyTokens, "lapsed gets the free quota");
    // Status still wins independently: a cancelled plan is free even if paid through next year.
    assert.equal(effectivePlan(p({ status: "canceled", paidThrough: now + 1e10 }), now).name, "free", "status still applies");
  }

  // --- a bad billing anchor must not switch metering off ---
  {
    const { periodStart } = await import("./server/plans.ts");
    const now = Date.UTC(2026, 7, 2, 12); // 2 Aug 2026
    const augustFirst = Date.UTC(2026, 7, 1);
    const plan = (periodStartValue: number | null) =>
      ({ user: "u", plan: "pro", status: "active", periodStart: periodStartValue }) as never;

    assert.equal(periodStart(plan(null), now), augustFirst, "no anchor means the calendar month");

    // THE ONE THAT MATTERS. A future anchor makes usageSince() look at a window that has not begun:
    // used reads 0, `used >= limit` never fires, and the account bills nothing forever. Found in
    // production as 12321313123123 — the year 2360.
    assert.equal(periodStart(plan(12321313123123), now), augustFirst, "an anchor in the future falls back to the month");
    assert.ok(periodStart(plan(12321313123123), now) <= now, "a period can never start in the future");

    // Garbage that isn't even a number must not produce NaN, which compares false against everything.
    assert.equal(periodStart(plan(Number.NaN), now), augustFirst, "NaN falls back to the month");

    // A real anchor still anchors: subscribed on the 20th, so the period runs from the 20th.
    assert.equal(
      periodStart(plan(Date.UTC(2026, 5, 20, 9, 30)), now),
      Date.UTC(2026, 6, 20, 9, 30),
      "an anchor rolls forward to the period containing now",
    );
    // An old anchor rolls forward rather than reaching back years.
    assert.ok(periodStart(plan(Date.UTC(1970, 4, 23)), now) > Date.UTC(2026, 5, 1), "a 1970 anchor still lands in 2026");
  }

  // --- .ada must not litter someone else's repo ---
  {
    const { ensureAdaDir } = await import("./client/settings.ts");
    const tmp = join(tmpdir(), `ada-gitignore-${Date.now()}`);
    const ada = join(tmp, ".ada");
    ensureAdaDir(ada);
    const gi = readFileSync(join(ada, ".gitignore"), "utf8");
    // The index is over a megabyte. Unignored it shows up in the user's `git status` and is one
    // `git add .` from being committed into their history.
    for (const cache of ["index.vec", "index.json", "brain.json", "graph.db"])
      assert.ok(gi.includes(cache), `.ada/.gitignore must cover ${cache}`);
    // Self-ignoring, so a .ada holding only caches leaves the repo completely clean.
    assert.ok(gi.includes(".gitignore"), ".ada/.gitignore must ignore itself");
    // But memory and skills are the user's, and meant to be committed and shared with the team.
    assert.ok(!/^memory\/?$/m.test(gi) && !/^skills\/?$/m.test(gi), "memory and skills must stay committable");

    // A second call must not clobber a file the user has edited — but an install from before
    // jobs.json existed still needs the line appended, or that project shows `?? .ada/jobs.json`
    // forever. Append, don't rewrite.
    writeFileSync(join(ada, ".gitignore"), "# mine\n");
    ensureAdaDir(ada);
    const gi2 = readFileSync(join(ada, ".gitignore"), "utf8");
    assert.ok(gi2.startsWith("# mine\n"), "the user's existing content is preserved, not rewritten");
    assert.ok(/^jobs\.json$/m.test(gi2), "jobs.json is appended for installs that predate it");

    // Calling again must not append a second copy of the line.
    ensureAdaDir(ada);
    assert.equal(readFileSync(join(ada, ".gitignore"), "utf8"), gi2, "appending jobs.json is idempotent");
    rmSync(tmp, { recursive: true, force: true });
  }

  // --- workspaceDirs: the prompt and the search must agree about which folders exist ---
  {
    const { workspaceDirs } = await import("./client/settings.ts");
    const before = process.env.ADA_EXTRA_DIRS;
    const sep = process.platform === "win32" ? ";" : ":";
    try {
      delete process.env.ADA_EXTRA_DIRS;
      assert.deepEqual(workspaceDirs(), [process.cwd()], "no extras means just the working directory");

      // Platform-shaped paths: on POSIX the list separator is ":", which is also the character a
      // Windows drive letter uses — "C:/x" in a colon-separated list is two segments, not one.
      const [one, two] = process.platform === "win32" ? ["C:/x/one", "C:/x/two"] : ["/x/one", "/x/two"];
      process.env.ADA_EXTRA_DIRS = [one, two].join(sep);
      assert.equal(workspaceDirs().length, 3, "cwd plus both extras");

      // Adding the folder you are already in must not search it twice — the same hits would come
      // back doubled and crowd out everything else.
      process.env.ADA_EXTRA_DIRS = [process.cwd(), one].join(sep);
      assert.equal(workspaceDirs().length, 2, "cwd repeated as an extra is dropped");

      process.env.ADA_EXTRA_DIRS = sep + sep;
      assert.deepEqual(workspaceDirs(), [process.cwd()], "empty segments are not folders");
    } finally {
      if (before === undefined) delete process.env.ADA_EXTRA_DIRS;
      else process.env.ADA_EXTRA_DIRS = before;
    }
  }

  // --- project_map: a folder's map ON DEMAND, so extra workspace folders cost nothing per turn ---
  {
    const pm = tool("project_map");
    const here = process.cwd();
    const r = await pm.run({ path: here });
    assert.ok(!r.isError && r.output.length > 0, "project_map maps the folder it is given");
    // The default has to be cwd, or a model that omits the argument silently maps nothing.
    assert.equal((await pm.run({})).output, r.output, "no path means the working directory");
    const bad = await pm.run({ path: join(here, "definitely-not-here-9x") });
    assert.ok(bad.isError, "a folder that isn't there is an error, not an empty map");
    // Free until called: the whole point is that extra folders don't ride on every turn.
    assert.equal(pm.needsApproval, false, "reading a map is not a destructive act");
    assert.ok(!pm.lazy, "project_map must always be offered — it is how the model reaches other folders");
  }

  // --- compaction fires at a share of the model's own window, not a flat number ---
  {
    const base = { client: {} as never, session: Session.create(), onApprove: async (): Promise<"yes"> => "yes" };
    const limitFor = (model: string, compactAt?: number) => new Agent({ ...base, model, compactAt }).compactLimit();
    const { contextOf } = await import("./client/models-dev.ts");

    assert.equal(limitFor("claude-opus-4-5"), 150_000, "200k window -> 150k");
    assert.equal(limitFor("claude-opus-4-8"), 750_000, "1M window -> 750k, not the old flat 100k");
    assert.equal(limitFor("no-such-model-xyz"), 100_000, "an uncatalogued model keeps the flat fallback");
    assert.equal(limitFor("claude-opus-4-5", 42_000), 42_000, "an explicit compactAt always wins");

    // The threshold must stay UNDER the window it came from — the whole point is compacting before
    // the provider refuses the request, so a share that ever rounded past the window would be worse
    // than the flat number it replaced.
    for (const m of ["claude-opus-4-5", "claude-opus-4-8", "gemini-2.5-pro"])
      assert.ok(limitFor(m) < contextOf(m)!, `${m}: threshold must sit below its own window`);

    // setModel must move it: a session switched onto a smaller window and left on the bigger
    // threshold would never compact, and would die on the provider's hard limit instead.
    const a = new Agent({ ...base, model: "claude-opus-4-8" });
    const big = a.compactLimit();
    a.setModel("claude-opus-4-5");
    assert.ok(a.compactLimit() < big, "switching to a smaller window lowers the threshold");
  }

  // --- provider routing (incl. the new cloudflare + groq/together disambiguation) ---
  {
    const { route } = await import("./server/router.ts");
    const { PROVIDERS } = await import("./server/config.ts");
    assert.ok("cloudflare" in PROVIDERS, "cloudflare provider is registered");
    assert.equal(route("@cf/moonshotai/kimi-k2.7-code"), "cloudflare", "@cf/ → cloudflare");
    assert.equal(route("groq/llama-3.3-70b"), "groq", "groq/ → groq");
    assert.equal(route("together/x"), "together", "together/ → together");
    assert.equal(route("claude-opus-4-8"), "anthropic", "claude → anthropic");
    assert.equal(route("gpt-5"), "openai", "gpt → openai");
    assert.equal(route("gemini-3-pro"), "google", "gemini → google");
    assert.equal(route("qwen3-coder"), "dashscope", "qwen → dashscope");
    assert.equal(route("anything-else"), "openrouter", "unmatched → openrouter");
  }

  // --- enterprise control plane: seats, policy, metering, audit (temp data dir, no HTTP) ---
  {
    const dir = join(tmpdir(), `ada-ent-${Date.now()}`);
    const ent = await import("./server/enterprise.ts");
    process.env.ADA_DATA_DIR = dir;
    try {
      assert.equal(ent.enterpriseMode(dir), false, "no seats + no admin key → enterprise mode off");
      const key = ent.createSeat("alice", "admin", dir);
      assert.ok(key.startsWith("ada_sk_") && key.length > 40, "seat keys are long and prefixed");
      assert.equal(ent.enterpriseMode(dir), true, "a seat activates enterprise mode");
      assert.deepEqual(ent.identifySeat(key, dir), { user: "alice", role: "admin" }, "seat key resolves to its identity");
      assert.equal(ent.identifySeat("ada_sk_wrong", dir), null, "unknown key → null");
      // The auth-bypass the review caught: Object.prototype keys must NOT authenticate.
      for (const evil of ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"]) {
        assert.equal(ent.identifySeat(evil, dir), null, `prototype key "${evil}" must not authenticate`);
      }
      assert.equal(ent.listSeats(dir)[0]!.keyPrefix.length, 14, "listing exposes only a key prefix");
      assert.equal(ent.disableSeat(key.slice(0, 8), dir), null, "too-short prefix refused");
      assert.equal(ent.disableSeat(key.slice(0, 14), dir), "alice", "disable by unique prefix");
      assert.equal(ent.identifySeat(key, dir), null, "disabled seat no longer authenticates");

      assert.ok(ent.modelAllowed("claude-opus-4-8", {}), "empty policy allows everything");
      const pol = { models: ["@cf/*", "claude-*"] };
      assert.ok(ent.modelAllowed("@cf/moonshotai/kimi-k2.7-code", pol), "wildcard allowlist matches");
      assert.ok(!ent.modelAllowed("gpt-5", pol), "non-listed model denied");

      ent.appendUsage({ ts: Date.now(), user: "alice", model: "m1", provider: "p", promptTokens: 100, completionTokens: 20 }, dir);
      ent.appendUsage({ ts: Date.now(), user: "alice", model: "m1", provider: "p", promptTokens: 50, completionTokens: 10 }, dir);
      ent.appendUsage({ ts: Date.now() - 90 * 86_400_000, user: "old", model: "m1", provider: "p", promptTokens: 999, completionTokens: 999 }, dir);
      const sum = ent.usageSummary(30, dir);
      assert.equal(sum.byUser.alice!.requests, 2, "usage aggregates per user");
      assert.equal(sum.totals.promptTokens, 150, "old rows fall outside the window");

      assert.ok(ent.auditTail(10, dir).some((e) => e.event === "seat_created"), "audit log records seat creation");

      const sse = 'data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"completion_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\n';
      assert.deepEqual(ent.extractLastUsage(sse), { promptTokens: 11, completionTokens: 7 }, "usage extracted from SSE tail (nested details ok)");
      assert.equal(ent.extractLastUsage("no usage here"), null, "no usage → null");
      // A trailing "usage": null must not hide the real one earlier in the stream.
      assert.deepEqual(ent.extractLastUsage('{"usage":{"prompt_tokens":5,"completion_tokens":3}}\n{"usage":null}'), { promptTokens: 5, completionTokens: 3 }, "trailing usage:null skipped, real one found");

      // policy validation rejects malformed shapes, accepts good ones
      assert.ok("error" in ent.validatePolicy({ models: [1, 2] }), "non-string models rejected");
      assert.ok("error" in ent.validatePolicy({ permissions: [{ tool: "x" }] }), "permission without action rejected");
      assert.ok("policy" in ent.validatePolicy({ models: ["@cf/*"], permissions: [{ tool: "bash", action: "deny" }] }), "valid policy accepted");

      // corrupt users.json → CorruptStore (fail-closed), NOT an empty map that unlocks the backend
      writeFileSync(join(dir, "users.json"), "{ this is not json");
      assert.throws(() => ent.loadSeats(dir), (e: unknown) => e instanceof ent.CorruptStore, "corrupt users.json throws CorruptStore");
      assert.equal(ent.enterpriseMode(dir), true, "corrupt store → still enterprise (locked), never open");
    } finally {
      delete process.env.ADA_DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- OIDC SSO (Stage 2): JIT seat invariants + hermetic RS256 id-token verification ---
  {
    const dir = join(tmpdir(), `ada-oidc-${Date.now()}`);
    const ent = await import("./server/enterprise.ts");
    const oidc = await import("./server/oidc.ts");
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const savedEnv = { ...process.env };
    const iss = "https://idp.example.com";
    process.env.ADA_DATA_DIR = dir;
    process.env.ADA_OIDC_ISSUER = iss;
    process.env.ADA_OIDC_CLIENT_ID = "ada-client";
    process.env.ADA_OIDC_ALLOWED_GROUPS = "engineering";
    process.env.ADA_OIDC_ADMIN_GROUP = "admins";
    try {
      // JIT seat provisioning invariants (the load-bearing new behavior).
      const ext = `${iss}#sub-123`;
      const k1 = ent.upsertSeatForSSO(ext, iss, "sso-user", "dev", dir);
      assert.ok(k1 && k1.startsWith("ada_sk_") && k1.length > 40, "OIDC JIT mints a valid seat key");
      assert.equal(ent.upsertSeatForSSO(ext, iss, "sso-user", "dev", dir), k1, "same iss#sub reuses one seat (no key rotation)");
      assert.equal(ent.upsertSeatForSSO(ext, iss, "sso-user", "admin", dir), k1, "existing seat is NOT auto-escalated to admin on login");
      assert.deepEqual(ent.identifySeat(k1!, dir), { user: "sso-user", role: "dev" }, "SSO seat key authenticates like any seat");
      assert.equal(ent.disableSeatByExternalId(ext, dir), "sso-user", "disable-by-externalId offboards");
      assert.equal(ent.upsertSeatForSSO(ext, iss, "sso-user", "dev", dir), null, "disabled externalId denies re-login (fail-closed deprovision, no resurrect)");
      assert.equal(ent.identifySeat(k1!, dir), null, "disabled SSO seat no longer authenticates");
      assert.equal(ent.seatByExternalId("__proto__", dir), null, "externalId scan is prototype-safe");
      // admin→dev downgrade when the admin group drops off a later login.
      const ext2 = `${iss}#boss`;
      const kb = ent.upsertSeatForSSO(ext2, iss, "boss", "admin", dir);
      assert.equal(ent.identifySeat(kb!, dir)!.role, "admin", "admin seat provisioned");
      assert.equal(ent.upsertSeatForSSO(ext2, iss, "boss", "dev", dir), kb, "downgrade reuses the same key");
      assert.equal(ent.identifySeat(kb!, dir)!.role, "dev", "admin→dev downgrade on group removal");

      // group/domain gate.
      assert.ok(oidc.isProvisionAllowed({ iss, sub: "s", name: "n", groups: ["engineering"] }), "allowed group provisions");
      assert.ok(!oidc.isProvisionAllowed({ iss, sub: "s", name: "n", groups: ["other"], email: "x@evil.com" }), "non-allowed group/domain refused");
      assert.equal(oidc.mapIdentityToSeatFields({ iss, sub: "z", name: "z", groups: ["admins"] }).role, "admin", "admin group → admin role");

      // Hermetic RS256 verification: sign a token locally, verify via an injected JWKS key.
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubJwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test", kty: "RSA" };
      const getKey = (kid: string) => (kid === "test" ? pubJwk : null);
      const now = 1_800_000_000_000;
      const sec = Math.floor(now / 1000);
      const b64u = (o: unknown): string => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
      const mkToken = (payload: Record<string, unknown>, alg = "RS256"): string => {
        const head = b64u({ alg, kid: "test", typ: "JWT" });
        const body = b64u(payload);
        if (alg === "none") return `${head}.${body}.`;
        return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
      };
      const good = { iss, aud: "ada-client", sub: "sub-123", exp: sec + 3600, iat: sec, groups: ["engineering"], email: "dev@corp.com" };
      const id = await oidc.verifyOidcToken(mkToken(good), { getKey, now });
      assert.ok(id && id.sub === "sub-123" && id.iss === iss, "valid RS256 id_token verifies");
      const validTok = mkToken(good);
      assert.equal(await oidc.verifyOidcToken(`${validTok.slice(0, -4)}AAAA`, { getKey, now }), null, "tampered signature → null");
      assert.equal(await oidc.verifyOidcToken(mkToken({ ...good, aud: "someone-else" }), { getKey, now }), null, "wrong audience → null");
      assert.equal(await oidc.verifyOidcToken(mkToken(good, "none"), { getKey, now }), null, "alg=none → null (no key confusion)");
      assert.equal(await oidc.verifyOidcToken(mkToken({ ...good, exp: sec - 7200 }), { getKey, now }), null, "expired token → null");
      // email is trusted only when the IdP marks it verified (domain-provisioning fail-open fix).
      const idU = await oidc.verifyOidcToken(mkToken({ ...good, email: "x@corp.com", email_verified: false }), { getKey, now });
      assert.ok(idU && idU.email === undefined, "unverified email dropped from identity");
      const idV = await oidc.verifyOidcToken(mkToken({ ...good, email: "x@corp.com", email_verified: true }), { getKey, now });
      assert.equal(idV!.email, "x@corp.com", "verified email kept");

      // SSRF guard classifies against a parsed IP (net.isIP), not a string prefix.
      for (const bad of ["https://[::1]/keys", "https://[fe80::1]/keys", "https://[fc00::1]/keys", "https://[::ffff:127.0.0.1]/keys", "https://127.0.0.1/keys", "https://10.1.2.3/keys", "http://idp.okta.com/keys"]) {
        assert.throws(() => oidc.assertSafeJwksUri(bad), `jwks_uri rejected: ${bad}`);
      }
      for (const ok of ["https://fcm.googleapis.com/keys", "https://fd-idp.corp.com/keys", "https://your-tenant.okta.com/oauth2/v1/keys"]) {
        assert.doesNotThrow(() => oidc.assertSafeJwksUri(ok), `jwks_uri allowed: ${ok}`);
      }
    } finally {
      for (const k of ["ADA_DATA_DIR", "ADA_OIDC_ISSUER", "ADA_OIDC_CLIENT_ID", "ADA_OIDC_ALLOWED_GROUPS", "ADA_OIDC_ADMIN_GROUP"]) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- auto-memory: recall relevance, supersede, secret gate, scoping, pinned, reference ---
  {
    const dir = join(tmpdir(), `ada-mem-${Date.now()}`);
    process.env.ADA_MEMORY_DIR = dir;
    // Semantic recall off: the selfcheck must stay offline and deterministic, and this also asserts
    // the real guarantee — every behaviour below holds on the lexical path alone.
    process.env.ADA_MEMORY_SEMANTIC = "0";
    const mem = await import("./client/memory.ts");
    try {
      assert.ok(mem.rememberFact({ text: "We deploy from the release branch", scope: "project", type: "decision" }).ok, "remember a project fact");
      assert.ok(mem.rememberFact({ text: "I prefer terse output", scope: "user", type: "preference" }).ok, "remember a user fact");
      assert.equal(mem.loadMemories(true).length, 2, "both scopes load when project is trusted");
      assert.equal(mem.loadMemories(false).length, 1, "only the user fact loads when project is untrusted");

      // dedup: a near-identical fact adds no line
      const before = mem.loadMemories(true).length;
      mem.rememberFact({ text: "we deploy from the release branch", scope: "project" });
      assert.equal(mem.loadMemories(true).length, before, "dedup: near-identical fact is a NOOP");

      // supersede a same-subject value change; coexist across different subjects
      mem.rememberFact({ text: "test runner is jest", scope: "project", type: "convention" });
      mem.rememberFact({ text: "test runner is vitest", scope: "project", type: "convention" });
      const runners = mem.loadMemories(true).filter((m) => m.text.includes("test runner"));
      assert.equal(runners.length, 1, "supersede: only the newest same-subject fact is live");
      assert.ok(runners[0]!.text.includes("vitest"), "supersede: the newest value wins");
      mem.rememberFact({ text: "uses pnpm for the web app", scope: "project" });
      mem.rememberFact({ text: "uses cargo for the rust crate", scope: "project" });
      assert.equal(mem.loadMemories(true).filter((m) => m.text.startsWith("uses")).length, 2, "different subjects coexist");
      mem.rememberFact({ text: "never delete the prod database", scope: "project", type: "gotcha" });
      mem.rememberFact({ text: "never delete stale feature branches", scope: "project", type: "convention" });
      assert.equal(mem.loadMemories(true).filter((m) => m.text.startsWith("never delete")).length, 2, "shared-bigram-but-distinct facts coexist (no over-supersede)");

      // secret gate — refuse on write, allow a plain hex sha
      for (const secret of ["my key is sk-abcdefghijklmnop1234", "AKIAABCDEFGHIJKLMNOP", "token=ghp_0123456789abcdefghijklmnop", "password=hunter2horse99", "ada_sk_" + "a".repeat(48)]) {
        assert.ok(!mem.rememberFact({ text: secret }).ok, `secret refused: ${secret.slice(0, 14)}…`);
      }
      assert.ok(mem.redactScan("the base commit is a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2").ok, "a plain hex sha is not flagged");
      assert.ok(!mem.redactScan("deploy token ZXCVBNM1234567890ASDFGHJKLQWERTY").ok, "two-class high-entropy key refused (was the gate bypass)");
      assert.ok(mem.redactScan("the auth handler is verifyBetterAuthSession").ok, "a long camelCase identifier is not flagged as a secret");
      assert.ok(!mem.redactScan("gemini key AIzaSyA1234567890abcdefghijklmnopqrstuvwx").ok, "a Gemini AIza key is refused");
      assert.ok(!mem.redactScan("anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345").ok, "a hyphenated sk-ant key is refused");
      assert.ok(mem.redactScan("the disk-usage-monitoring-dashboard and task-tracker-service-account are green").ok, "kebab-case identifiers are NOT flagged (sk- must be word-anchored)");
      assert.ok(!mem.rememberFact({ text: "the template marker is <!-- here -->" }).ok, "a comment marker in fact text is refused");

      // recall: relevant surfaces, off-topic injects nothing
      const hit = await mem.recallBlock("what branch do we deploy from", true);
      assert.ok(hit && hit.includes("release branch"), "recall surfaces the relevant fact");
      const off = await mem.recallBlock("quantum chromodynamics lunch menu roster", true);
      assert.ok(!(off ?? "").includes("release branch") && !(off ?? "").includes("test runner"), "off-topic recall surfaces no ranked project facts (floor)");

      // pinned is always recalled regardless of query
      const g = mem.rememberFact({ text: "prod migrations need ops on-call sign-off", scope: "project", type: "gotcha" });
      assert.ok(g.ok);
      await mem.memoryCommand(["pin", (g as { memory: { id: string } }).memory.id], true);
      const pinnedBlock = await mem.recallBlock("some entirely unrelated question about widgets", true);
      assert.ok(pinnedBlock && pinnedBlock.includes("ops on-call sign-off"), "pinned fact is recalled for any query");

      // reference: the body is never in the recall block (only the title)
      mem.rememberFact({ text: "release runbook", scope: "project", type: "reference", body: "STEP-BODY-SECRET-MARKER: do the release" });
      const refBlock = await mem.recallBlock("release runbook steps", true);
      assert.ok(!(refBlock ?? "").includes("STEP-BODY-SECRET-MARKER"), "reference body is not auto-injected");

      // judged write: explicit supersedes retires the named ids and REPLACES the subject heuristic,
      // so a reworded fact the bigram guess would miss still retires the one it contradicts.
      const oldF = mem.rememberFact({ text: "the staging box is rebuilt nightly", scope: "project" });
      assert.ok(oldF.ok);
      const oldId = (oldF as { memory: { id: string } }).memory.id;
      const merged = mem.rememberFact({ text: "staging is rebuilt every night at 02:00 UTC", scope: "project", supersedes: [oldId] });
      assert.ok(merged.ok, "judged write stores");
      const live = mem.loadMemories(true).filter((m) => m.text.includes("staging"));
      assert.equal(live.length, 1, "explicit supersedes retires the target");
      assert.ok(live[0]!.text.includes("02:00"), "the judged wording is what stays live");
      // a target that no longer exists must be a no-op, never a thrown write
      assert.ok(mem.rememberFact({ text: "the linter is biome", scope: "project", supersedes: ["m-does-not-exist"] }).ok, "unknown supersede target is harmless");

      // usage signal: recall records that a fact was used, and is throttled to once per fact per day
      // so the hot path can't rewrite the ledger every turn.
      const hitsOf = (): number => mem.loadMemories(true).find((m) => m.text.includes("biome"))!.hits;
      assert.equal(hitsOf(), 0, "a never-recalled fact has no hits");
      await mem.recallBlock("which linter biome", true);
      assert.equal(hitsOf(), 1, "recall records usage");
      await mem.recallBlock("which linter biome", true);
      assert.equal(hitsOf(), 1, "a second recall the same day does not rewrite the ledger");
      const stillOff = await mem.recallBlock("quantum chromodynamics lunch menu roster", true);
      assert.ok(!(stillOff ?? "").includes("release branch"), "a recalled-often fact still respects the relevance floor");
    } finally {
      delete process.env.ADA_MEMORY_DIR;
      delete process.env.ADA_MEMORY_SEMANTIC;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- memory LLM passes: reply parsing is tolerant, and never trusts what it wasn't shown ---
  {
    const llm = await import("./client/memory-llm.ts");
    assert.deepEqual(llm.parseFacts("[]"), [], "empty extraction is a valid answer");
    assert.deepEqual(llm.parseFacts("total nonsense, no json here"), [], "unparseable extraction yields nothing");
    const fenced = llm.parseFacts('```json\n[{"text":"the test runner is vitest","type":"convention","scope":"project"}]\n```');
    assert.equal(fenced.length, 1, "a fenced reply still parses");
    assert.equal(fenced[0]!.type, "convention");
    assert.equal(llm.parseFacts('[{"text":"short","type":"fact"}]').length, 0, "a too-short fact is dropped");
    assert.equal(llm.parseFacts(`[{"text":"${"x".repeat(300)}","type":"fact"}]`).length, 0, "a paragraph-length 'fact' is a summary, dropped");
    assert.equal(llm.parseFacts('[{"text":"a fact one here","type":"nonsense"}]')[0]!.type, "fact", "an unknown type falls back to fact");
    // Asserted against the exported constant, not a literal — the cap is a tuned value (raised from
    // 3 to 6 after bench/extraction.ts showed it capping recall on dense sessions) and the invariant
    // being tested is "there IS a cap", not what it currently equals.
    const many = Array.from({ length: llm.MAX_PER_PASS + 4 }, (_, i) => `{"text":"durable fact number ${i}"}`).join(",");
    assert.equal(llm.parseFacts(`[${many}]`).length, llm.MAX_PER_PASS, "extraction is capped per pass");

    const offered = new Set(["m1", "m2"]);
    assert.equal(llm.parseJudgment('{"action":"skip","targets":[],"text":"x"}', "new fact", offered).action, "skip");
    assert.deepEqual(llm.parseJudgment('{"action":"update","targets":["m1","m9"],"text":"merged wording"}', "new fact", offered).targets, ["m1"], "a hallucinated target id is discarded");
    assert.equal(llm.parseJudgment('{"action":"update","targets":["m9"],"text":"merged wording"}', "new fact", offered).action, "store", "an update with no surviving target degrades to store, never a silent drop");
    assert.equal(llm.parseJudgment("garbage", "new fact", offered).action, "store", "an unparseable judgment defaults to store");
    assert.equal(llm.parseJudgment("garbage", "new fact", offered).text, "new fact", "…keeping the original wording");
  }

  // --- org policy merge: restrictive wins, org can tighten but never loosen ---
  {
    const { permissionFor, setActiveAgentPermissions, setOrgPermissions } = await import("./client/settings.ts");
    setActiveAgentPermissions([{ tool: "bash", action: "allow" }]);
    setOrgPermissions([{ tool: "bash", action: "deny" }]);
    assert.equal(permissionFor("bash", "x"), "deny", "org deny beats local allow");
    setOrgPermissions([{ tool: "bash", action: "ask" }]);
    assert.equal(permissionFor("bash", "x"), "ask", "org ask upgrades local allow");
    setActiveAgentPermissions([{ tool: "bash", action: "deny" }]);
    setOrgPermissions([{ tool: "bash", action: "allow" }]);
    assert.equal(permissionFor("bash", "x"), "deny", "org allow cannot loosen a local deny");
    setActiveAgentPermissions([]);
    assert.equal(permissionFor("bash", "x"), null, "org allow cannot loosen the default gating");
    setOrgPermissions(null);
    setActiveAgentPermissions(null);
  }

  // --- @codebase semantic search: pure parts (no network / no embedding model needed) ---
  {
    const { chunkText, cosine, walkFiles } = await import("./client/embed-index.ts");
    const chunks = chunkText(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
    assert.equal(chunks.length, 3, "200 lines → 3 chunks of 80");
    assert.equal(chunks[0]!.start, 1);
    assert.equal(chunks[1]!.start, 81);
    assert.equal(chunks[2]!.end, 200, "last chunk ends at the last line");
    assert.equal(chunkText("   \n \n").length, 0, "whitespace-only text → no chunks");
    assert.ok(chunkText(`x${"y".repeat(50_000)}`)[0]!.text.length <= 6000, "long-line chunks are char-capped");
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, "cosine identical = 1");
    assert.equal(cosine([1, 0], [0, 1]), 0, "cosine orthogonal = 0");
    assert.equal(cosine([0, 0], [1, 1]), 0, "zero vector → 0, not NaN");
    const walked = walkFiles(process.cwd());
    assert.ok(walked.includes("src/selfcheck.ts"), "walkFiles finds source files");
    assert.ok(!walked.some((f) => f.includes("node_modules")), "walkFiles skips node_modules");
    // Offline: the tool must fail with a clear message, not hang or throw
    const r = await toolByName.get("codebase_search")!.run({ query: "x" });
    assert.ok(typeof r.output === "string", "codebase_search returns cleanly even when embeddings are unavailable");
  }

  // --- `ada --version` prints the version and exits WITHOUT auto-starting a backend ---
  {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const bin = fileURLToPath(new URL("../bin/ada.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", timeout: 30_000 });
    assert.match(r.stdout, /^ada \d+\.\d+\.\d+/, `--version prints the version (got: ${JSON.stringify(r.stdout)} / ${JSON.stringify(r.stderr?.slice(0, 120))})`);
    assert.ok(!/starting ada-server/.test(r.stderr ?? ""), "--version must not auto-start the backend");
  }

  // --- autostart helpers: URL classification + /health derivation ---
  {
    const { isLocalBackend, healthUrl, modelsUrl } = await import("./client/autostart.ts");
    assert.ok(isLocalBackend("http://localhost:8787/v1"), "localhost is local");
    assert.ok(isLocalBackend("http://127.0.0.1:8787/v1"), "127.0.0.1 is local");
    assert.ok(!isLocalBackend("https://ada.example.com/v1"), "remote URL is not local");
    assert.equal(healthUrl("http://localhost:8787/v1"), "http://localhost:8787/health", "/v1 base → /health");
    assert.equal(healthUrl("http://localhost:8787"), "http://localhost:8787/health", "bare base → /health");
    // /models keeps the /v1 — it is an API path, unlike /health which sits at the root. Getting
    // this wrong is what makes a third-party gateway look dead and sends ada off to spawn its own.
    assert.equal(modelsUrl("http://localhost:20128/v1"), "http://localhost:20128/v1/models", "/v1 base → /v1/models");
    assert.equal(modelsUrl("http://localhost:20128/v1/"), "http://localhost:20128/v1/models", "a trailing slash is not a path segment");
    // Remote URL → ensureBackend short-circuits to "remote" without spawning anything.
    const { ensureBackend } = await import("./client/autostart.ts");
    const v = await ensureBackend("https://ada.example.com/v1", { quiet: true, waitMs: 200 });
    assert.equal(v, "remote", "remote URL returns 'remote' without spawning");
  }

  // --- background job runs and reports ---
  const jid = startJob("selfcheck job", async () => "job-done-ok");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(renderJobs().includes(jid) && /job-done-ok/.test(renderJobs()), "background job runs and reports its result");

  // --- jobs survive a restart, and a restart does not lie about what was running ---
  {
    const { reviveJobs } = await import("./client/background.ts");

    // A job still marked "running" belongs to a process that is gone. Loading it faithfully would
    // show it running forever — a worse bug, and a permanent one, than the unreachable result this
    // whole change is about.
    const stale = reviveJobs([
      { id: "j1", task: "was running when serve died", status: "running", started: 1 },
      { id: "j2", task: "finished cleanly", status: "done", result: "the answer", started: 2, ended: 3 },
    ]);
    assert.equal(stale.jobs.length, 2, "revive keeps both jobs");
    assert.equal(stale.jobs[0]!.status, "error", "a running job loads as interrupted, not running");
    assert.match(stale.jobs[0]!.result ?? "", /restart/i, "and says why it is interrupted");
    assert.equal(stale.jobs[1]!.status, "done", "a finished job loads untouched");
    assert.equal(stale.jobs[1]!.result, "the answer", "with its result intact — the point of persisting");

    // Ids are `j${++seq}` off a module counter. Without continuing the sequence, a restart hands
    // out j1 again and silently overwrites the persisted j1 — destroying the very result we saved.
    assert.equal(reviveJobs([{ id: "j7", task: "t", status: "done", started: 1 }]).nextSeq, 7, "seq continues from the highest id");
    assert.equal(reviveJobs([]).nextSeq, 0, "an empty store starts the sequence at zero");

    // A corrupt or hand-edited file must not take the agent down with it.
    assert.deepEqual(reviveJobs(null), { jobs: [], nextSeq: 0 }, "null parses to an empty store");
    assert.deepEqual(reviveJobs("nonsense"), { jobs: [], nextSeq: 0 }, "a non-array parses to an empty store");
    assert.equal(reviveJobs([{ nope: true }, { id: "j3", task: "ok", status: "done", started: 1 }]).jobs.length, 1, "junk entries are dropped, good ones kept");
    assert.equal(reviveJobs([{ nope: true }, { id: "j3", task: "ok", status: "done", started: 1 }]).nextSeq, 3, "and junk does not disturb the sequence");

    // save() must merge with disk, not clobber it: a second `ada` in the same folder — the app's
    // serve for the open project, say, beside a terminal `ada` — has its own Map and writes the same
    // file. Blind overwrite means each one's save() erases whatever the other added since its own
    // load(). A job this process never created should still be there after a save() of its own.
    {
      const jobsPath = join(process.cwd(), ".ada", "jobs.json");
      const onDisk = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, "utf8")) : [];
      const foreignId = "j_selfcheck_foreign";
      // A recent `started` matters: capJobs keeps the *newest* finished jobs, and this file already
      // has decades of prior selfcheck runs' entries in it — an old timestamp would make the foreign
      // job look stale and get pruned for a reason that has nothing to do with the merge being tested.
      const now = Date.now();
      writeFileSync(
        jobsPath,
        JSON.stringify(
          [...onDisk, { id: foreignId, task: "left by another ada in this folder", status: "done", result: "not ours", started: now, ended: now }],
          null,
          2,
        ),
      );
      // Any startJob() triggers a save() as a side effect — that is the real code path, not a
      // reach into internals.
      startJob("triggers a save so the merge above actually runs", async () => "ok");
      await new Promise((r) => setTimeout(r, 30));
      const after = JSON.parse(readFileSync(jobsPath, "utf8"));
      assert.ok(Array.isArray(after) && after.some((j: { id?: string }) => j.id === foreignId), "save() merges in a job it never created instead of overwriting the file with only its own");
    }

    // Pruning ranks by start time, which would age out a job that is still running once enough newer
    // jobs pile up — losing the one result the whole file exists to keep. A running job must never
    // be dropped for being old, even past the 50-job cap; only finished jobs are ever trimmed.
    const { listJobs } = await import("./client/background.ts");
    for (let i = 0; i < 55; i++) startJob(`long job ${i}`, () => new Promise<string>(() => {})); // never resolves
    const stillRunning = listJobs().filter((j) => j.status === "running" && j.task.startsWith("long job"));
    assert.equal(stillRunning.length, 55, "every running job survives a prune, even past the 50-job cap");
  }

  // --- a tool learns which session called it -------------------------------------------------
  {
    const { registerTool, toolByName } = await import("./client/tools.ts");
    let seen: string | undefined = "unset";
    registerTool({
      name: "selfcheck_ctx_echo",
      description: "selfcheck only",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      needsApproval: false,
      async run(_args, ctx) {
        seen = ctx?.sessionId;
        return { output: "ok" };
      },
    });
    // Called the way the agent calls it, rather than through a whole turn: the contract under test
    // is "the ctx reaches run()", and a live model round trip would prove nothing extra.
    await toolByName.get("selfcheck_ctx_echo")!.run({}, { sessionId: "sess-abc" });
    assert.equal(seen, "sess-abc", "a tool receives the calling session's id");
    await toolByName.get("selfcheck_ctx_echo")!.run({});
    assert.equal(seen, undefined, "and undefined when the caller has no session — a terminal agent");
  }

  // --- a job remembers which chat started it -------------------------------------------------
  {
    const { startJob, reviveJobs } = await import("./client/background.ts");
    startJob("attributed job", async () => "done", "sess-xyz");
    startJob("terminal job", async () => "done");

    // The field has to survive a restart, or attribution silently resets to unscoped.
    const revived = reviveJobs([{ id: "j99", task: "t", status: "done", result: "r", started: 1, ended: 2, sessionId: "sess-xyz" }]);
    assert.equal(revived.jobs[0]!.sessionId, "sess-xyz", "reviveJobs carries sessionId across a restart");
  }

  // --- agent-server helpers: SSE framing, id uniqueness, approval correlation (no live model needed) ---
  {
    const { sseFrame, newId, ApprovalRegistry } = await import("./client/agent-server.ts");
    assert.equal(sseFrame({ type: "done", text: "hi" }), 'data: {"type":"done","text":"hi"}\n\n', "sseFrame formats one data: frame");
    const a = newId("sess");
    const b = newId("sess");
    assert.ok(a.startsWith("sess_") && a !== b, "newId is prefixed and unique");

    const registry = new ApprovalRegistry();
    const { id, promise } = registry.wait();
    assert.equal(registry.size, 1, "wait() tracks one pending approval");
    assert.ok(registry.settle(id, "yes"), "settle() resolves a known pending approval");
    assert.equal(await promise, "yes", "the waiting promise resolves with the decision");
    assert.equal(registry.size, 0, "settle() clears the pending entry");
    assert.equal(registry.settle("nope", "no"), false, "settle() on an unknown id returns false");

    // abortAll: an aborted turn must not stay parked on unanswered approvals
    const a1 = registry.wait();
    const a2 = registry.wait();
    assert.equal(registry.abortAll(), 2, "abortAll reports how many were pending");
    assert.equal(await a1.promise, "no", "aborted approvals resolve to 'no'");
    assert.equal(await a2.promise, "no", "all of them");
    assert.equal(registry.size, 0, "abortAll clears the registry");
  }
  assert.equal((await toolByName.get("web_fetch")!.run({ url: "http://127.0.0.1/x" })).isError, true, "web_fetch blocks loopback (SSRF guard)");

  // --- destructive classifier: real dangers flagged; everyday redirects are not (2>/dev/null bug) ---
  // The /dev/ sink allow-list is boundary-anchored, so device writes whose name starts with a sink
  // token (ttyS0, tty1) are still caught — they were a confirmed bypass before the fix.
  for (const c of ["rm -rf /", "dd if=/dev/zero of=/dev/sda", "git push --force origin main", "git reset --hard", "> /dev/sda", "> /dev/ttyS0", "echo x > /dev/tty1"]) {
    assert.ok(isDestructive(c), `should be destructive: ${c}`);
  }
  for (const c of ['ls "/some/dir" 2>/dev/null', "cat x >/dev/null", "echo hi > /dev/stdout", "grep foo bar 2> /dev/null", "node app.js &>/dev/null", "x >/dev/null 2>&1", "cat >/dev/tty"]) {
    assert.ok(!isDestructive(c), `should NOT be destructive: ${c}`);
  }

  // --- leaked tool-call recovery (Ollama-over-stream emits the call as text) ---
  const leaked = parseTextToolCalls('{"name": "update_todos", "arguments": {"todos": []}}');
  assert.equal(leaked?.[0]?.name, "update_todos", "plain JSON tool call recovered");
  const tagged = parseTextToolCalls('<tool_call>{"name":"ls","arguments":{"path":"."}}</tool_call>');
  assert.equal(tagged?.[0]?.name, "ls", "<tool_call> wrapped call recovered");
  assert.equal(parseTextToolCalls('{"name":"spend_time","arguments":{}}'), null, "unknown tool not treated as a call");
  assert.equal(parseTextToolCalls("just some prose"), null, "prose is not a tool call");

  // --- TUI user bar fills the full width (no void, single styled echo) ---
  const bar = userBar("hi", 40);
  assert.ok(bar.includes("hi") && bar.includes("›"), "user bar shows the text + marker");
  assert.ok(bar.includes("\x1b[48;5;238m"), "user bar has a full-width background");
  assert.ok(userBar("x".repeat(200), 40).length > 40, "over-long input does not crash padding");

  // --- bundled skills load + scalable discovery (list_skills / slim use_skill) ---
  const allSkills = loadSkills(true);
  const skillNames = allSkills.map((s) => s.name);
  assert.ok(skillNames.length >= 200, `>=200 skills load (got ${skillNames.length})`);
  for (const want of ["commit", "ponytail", "dockerize", "migration", "react-hooks", "terraform-module", "pixel-diff", "canvas-debug", "connect-github", "design-system"]) {
    assert.ok(skillNames.includes(want), `bundled skill present: ${want}`);
  }
  registerSkillTool(allSkills);
  const useSkill = toolByName.get("use_skill")!;
  assert.ok(useSkill.description.length < 400, `use_skill description is slim (got ${useSkill.description.length})`);
  const listSkills = toolByName.get("list_skills")!;
  const filtered = (await listSkills.run({ filter: "docker" })).output;
  assert.ok(/dockerize/.test(filtered) && !/migration/.test(filtered), "list_skills filter narrows results");
  assert.ok(/categories/.test((await listSkills.run({})).output), "list_skills overview lists categories");

  // --- skill routing (lexical relevance ranker behind find_skill + auto-suggest) ---
  assert.ok(rankSkills("write a database migration", allSkills, 5).some((r) => r.name === "migration"), "routing surfaces migration");
  assert.ok(rankSkills("set up a dark mode theme", allSkills, 5).some((r) => r.name === "dark-mode"), "routing surfaces dark-mode");
  const dockerTop = rankSkills("build a docker image for the app", allSkills, 5).map((r) => r.name);
  assert.ok(dockerTop.includes("dockerize") || dockerTop.includes("docker-compose"), `routing surfaces a docker skill (got ${dockerTop.join(",")})`);
  assert.equal(rankSkills("", allSkills).length, 0, "empty query → no matches");

  // --- confident skill orchestration: auto-apply only on a dominant, name-exact match ---
  assert.equal(confidentSkill("describe the project", allSkills), "project-overview", "confident: describe the project → project-overview");
  assert.equal(confidentSkill("draw an architecture diagram of this project", allSkills), "architecture-diagram", "confident: → architecture-diagram");
  assert.equal(confidentSkill("make a powerpoint about Q3 results", allSkills), null, "precision guard: 'powerpoint' must NOT auto-apply 'low-power'");
  assert.equal(confidentSkill("what is 2 + 2", allSkills), null, "ambiguous query → no auto-apply");
  // Coverage gate — a long sentence merely CONTAINING a skill-y keyword must not auto-apply
  // (observed live: this exact prompt pulled in secret-scan and derailed a small model).
  assert.equal(
    confidentSkill("Remember this fact for later: the secret word is PINEAPPLE97. Just confirm you will remember it, do not do anything else.", allSkills),
    null,
    "coverage gate: incidental 'secret' must NOT auto-apply secret-scan",
  );
  assert.equal(confidentSkill("I was talking to my friend about docker yesterday and she mentioned kubernetes", allSkills), null, "coverage gate: conversational mention of docker");
  // Short rephrasings of the same incident — prefix-matching must not inflate coverage
  // ("remember" prefix-matches "remediate"), and 1/3 exactly must not pass the strict gate.
  assert.equal(confidentSkill("remember this: the secret word is X", allSkills), null, "coverage gate: short secret-word phrasing");
  assert.equal(confidentSkill("remember the secret word", allSkills), null, "coverage gate: shortest secret-word phrasing");
  // LOADED was set by registerSkillTool(allSkills) above, so routeConfident/skillBody resolve a body.
  const applied = routeConfident("describe the project");
  assert.ok(applied?.name === "project-overview" && /purpose/i.test(applied.body), "routeConfident returns the skill body to inject");
  assert.equal(routeConfident("make a powerpoint about Q3 results"), null, "routeConfident respects the precision guard");

  // --- connector catalog (read-only; does not touch .ada/mcp.json) ---
  const catalog = listConnectors();
  assert.ok(catalog.length >= 8 && catalog.some((c) => c.name === "github"), "connector catalog populated");
  assert.ok(catalog.find((c) => c.name === "github")?.needsEnv.includes("GITHUB_PERSONAL_ACCESS_TOKEN"), "github connector declares its env var");

  // --- toolsmith path end-to-end via a real stub MCP server (skips if a real .ada/mcp.json exists) ---
  const adaDir = join(process.cwd(), ".ada");
  const mcpCfg = join(adaDir, "mcp.json");
  if (!existsSync(mcpCfg) && existsSync(join(process.cwd(), "test", "stub-mcp.mjs"))) {
    mkdirSync(adaDir, { recursive: true });
    writeFileSync(mcpCfg, JSON.stringify({ servers: { stub: { command: "node", args: ["test/stub-mcp.mjs"] } } }));
    try {
      const loaded = await loadMcpServers(true);
      assert.ok(loaded.some((l) => l.startsWith("stub")), "stub MCP server connected + tools registered");
      assert.deepEqual(configuredServers(), ["stub"], "configuredServers sees the stub");
      assert.equal(soleIntegration(), "stub", "soleIntegration → stub");
      const docs = readIntegrationDocs("stub");
      assert.ok(/stub__echo/.test(docs) && /stub__add/.test(docs), "readDocs lists the stub's tools");
      const n = writeProjectSkills([
        { name: "stub-echo", content: "---\nname: stub-echo\ndescription: echo via the stub\ncategory: integration-stub\n---\n# Echo\n1. call stub__echo\n## Rules\n- keep it short" },
        { name: "stub-junk", content: "not a skill file" },
      ]);
      assert.equal(n, 1, "writeProjectSkills writes valid skills and skips junk");
      assert.ok(existsSync(join(adaDir, "skills", "stub-echo", "SKILL.md")), "stub-echo SKILL.md written");
    } finally {
      rmSync(mcpCfg, { force: true });
      rmSync(join(adaDir, "skills", "stub-echo"), { recursive: true, force: true });
    }
  }

  // --- login allowlist ---
  assert.ok(isAllowed("anyone"), "no allowlist → allow any authenticated user");
  process.env.ADA_ALLOWED_USERS = "alice, bob";
  assert.ok(isAllowed("alice"));
  assert.ok(!isAllowed("carol"), "off-allowlist user rejected");
  delete process.env.ADA_ALLOWED_USERS;

  // --- db-backed allowlist (sqlite fallback here; postgres takes the same SQL shape) ---
  {
    process.env.ADA_AUTH_DB = join(tmpdir(), `ada-allow-${Date.now()}.db`);
    const { addAllowed, isAllowedUser, listAllowed, removeAllowed } = await import("./server/allowlist.ts");
    assert.ok(await isAllowedUser("anyone"), "empty env + empty table -> open");
    await addAllowed("vikash@example.com", "selfcheck");
    assert.ok(await isAllowedUser("vikash@example.com"), "db row admits");
    assert.ok(!(await isAllowedUser("mallory@example.com")), "non-empty table -> gate active");
    process.env.ADA_ALLOWED_USERS = "founder";
    assert.ok(await isAllowedUser("founder"), "env and db union");
    assert.ok(await isAllowedUser("vikash@example.com"), "db entry survives env being set");
    delete process.env.ADA_ALLOWED_USERS;
    assert.equal((await listAllowed()).length, 1, "one row listed");
    assert.ok(await removeAllowed("vikash@example.com"), "remove reports true");
    assert.ok(await isAllowedUser("anyone"), "empty again -> open");
  }

  // --- popular-model picker: newest per family, deduped, valid ids only ---
  {
    const live = [
      "anthropic/claude-opus-4.1-20240229", "anthropic/claude-opus-4.8", "x-ai/grok-2-1212", "x-ai/grok-4",
      "qwen/qwen-2.5-72b-instruct", "qwen/qwen3-235b", "moonshotai/kimi-k2", "deepseek/deepseek-chat",
      "google/gemini-2.0-flash", "openai/gpt-4o", "meta-llama/llama-3.1-70b",
    ];
    const pop = popularModels(live);
    const byLabel = Object.fromEntries(pop.map((p) => [p.label, p.id]));
    assert.equal(byLabel["Claude Opus"], "anthropic/claude-opus-4.8", "newest Opus: 4.8 beats the date-stamped 4.1");
    assert.equal(byLabel["Grok"], "x-ai/grok-4", "picks grok-4 over grok-2-1212");
    assert.equal(byLabel["Qwen"], "qwen/qwen3-235b", "picks qwen3 over qwen-2.5 despite the naming mismatch");
    assert.ok(pop.every((p) => live.includes(p.id)), "every featured id is a real live id");
    assert.equal(new Set(pop.map((p) => p.id)).size, pop.length, "no duplicate ids");
    assert.equal(popularModels(["ollama/llama3.2", "codellama"]).length, 0, "no popular families in a llama-only local list");
    assert.equal(popularModels(["qwen2.5-coder:7b"]).length, 1, "a local qwen is still featured");
    // prefer a concrete pinned id over an alias (~vendor/model, …-latest) — the tilde/latest forms
    // resolve server-side and caused the original "kimi answers as Claude" confusion.
    const withAlias = popularModels(["~anthropic/claude-opus-latest", "anthropic/claude-opus-4.8"]);
    assert.equal(withAlias[0]!.id, "anthropic/claude-opus-4.8", "concrete id beats the ~…-latest alias");
    assert.equal(popularModels(["~moonshotai/kimi-latest"])[0]!.id, "~moonshotai/kimi-latest", "alias still featured when it's the only match");
  }

  // --- provider status (the /v1/providers truth) ---
  {
    const st = providerStatus();
    const by = Object.fromEntries(st.map((s) => [s.name, s]));
    assert.equal(by.ollama!.source, "keyless", "ollama is keyless");
    assert.ok(by.ollama!.configured, "keyless counts as configured");
    for (const s of st) assert.equal(s.configured, s.source !== "none", "configured ⇔ has a source");
    assert.equal(route("~moonshotai/kimi-latest"), "openrouter", "alias ids with / still route to openrouter");
    assert.equal(route("claude-opus-4-8"), "anthropic");
  }

  // --- secret-env scrub (env handed to bash / MCP subprocesses) ---
  {
    const { isSecretEnvKey, scrubbedEnv } = await import("./client/secret-env.ts");
    for (const k of ["OPENROUTER_API_KEY", "ADA_ADMIN_KEY", "ADA_CLIENT_KEY", "BETTER_AUTH_SECRET", "CLOUDFLARE_API_TOKEN", "GEMINI_API_KEY", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]) assert.ok(isSecretEnvKey(k), `${k} is a crown-jewel secret`);
    for (const k of ["PATH", "HOME", "GITHUB_TOKEN", "AWS_REGION", "COMSPEC"]) assert.ok(!isSecretEnvKey(k), `${k} passes through (not ada's secret)`);
    process.env.ZZ_API_KEY = "sekret";
    process.env.ZZ_SAFE = "ok";
    const e = scrubbedEnv();
    assert.ok(!("ZZ_API_KEY" in e), "scrub removes a provider-shaped key");
    assert.equal(e.ZZ_SAFE, "ok", "scrub keeps ordinary vars");
    assert.equal(scrubbedEnv({ ZZ_API_KEY: "provided" }).ZZ_API_KEY, "provided", "explicitly-provided (MCP-own) creds survive the scrub");
    delete process.env.ZZ_API_KEY;
    delete process.env.ZZ_SAFE;
  }

  // --- server factory: constructs WITHOUT listening (the stable ./server surface the hosted wrap uses) ---
  {
    process.env.ADA_AUTH_DB = ":memory:"; // avoid writing a stray ada-auth.db during the import
    const { createAdaServer, startAdaServer } = await import("./server/index.ts");
    assert.equal(typeof createAdaServer, "function", "./server exports createAdaServer");
    assert.equal(typeof startAdaServer, "function", "./server exports startAdaServer");
    const srv = createAdaServer();
    assert.ok(!srv.listening, "createAdaServer() builds the server without calling listen()");
    srv.close();
  }

  console.log("selfcheck OK");
  process.exit(0); // a spawned stub MCP subprocess can hold stdin open — exit cleanly
}

main().catch((e) => {
  console.error("selfcheck FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
