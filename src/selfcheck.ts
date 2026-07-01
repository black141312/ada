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
import { describeCall, parseTextToolCalls, permPhrase, readIntegrationDocs, soleIntegration, writeProjectSkills } from "./client/agent.ts";
import { userBar } from "./client/tui.ts";
import { configuredServers, listConnectors, loadMcpServers } from "./client/mcp.ts";
import { confidentSkill, rankSkills } from "./client/skill-router.ts";
import { getDiagnostics } from "./client/lsp.ts";
import { snapshot } from "./client/snapshot.ts";
import { renderJobs, startJob } from "./client/background.ts";
import { formatFile, htmlToText, isDestructive, registerTool, setAsker, toolByName } from "./client/tools.ts";
import * as checkpoint from "./client/checkpoint.ts";
import { renderTodos, setTodos } from "./client/todos.ts";
import { deleteCredential, getCredential, setCredential } from "./server/credentials.ts";
import { isAllowed } from "./server/identity.ts";
import { route } from "./server/router.ts";

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
  setAsker(async (_q, opts) => (opts ? opts[0]! : "the-answer"));
  assert.ok(/the-answer/.test((await askTool.run({ question: "?" })).output), "ask_user returns the answer");
  assert.ok(/picked-A/.test((await askTool.run({ question: "?", options: ["picked-A", "B"] })).output), "ask_user with options");
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

  // --- autostart helpers: URL classification + /health derivation ---
  {
    const { isLocalBackend, healthUrl } = await import("./client/autostart.ts");
    assert.ok(isLocalBackend("http://localhost:8787/v1"), "localhost is local");
    assert.ok(isLocalBackend("http://127.0.0.1:8787/v1"), "127.0.0.1 is local");
    assert.ok(!isLocalBackend("https://ada.example.com/v1"), "remote URL is not local");
    assert.equal(healthUrl("http://localhost:8787/v1"), "http://localhost:8787/health", "/v1 base → /health");
    assert.equal(healthUrl("http://localhost:8787"), "http://localhost:8787/health", "bare base → /health");
    // Remote URL → ensureBackend short-circuits to "remote" without spawning anything.
    const { ensureBackend } = await import("./client/autostart.ts");
    const v = await ensureBackend("https://ada.example.com/v1", { quiet: true, waitMs: 200 });
    assert.equal(v, "remote", "remote URL returns 'remote' without spawning");
  }

  // --- background job runs and reports ---
  const jid = startJob("selfcheck job", async () => "job-done-ok");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(renderJobs().includes(jid) && /job-done-ok/.test(renderJobs()), "background job runs and reports its result");

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

  console.log("selfcheck OK");
  process.exit(0); // a spawned stub MCP subprocess can hold stdin open — exit cleanly
}

main().catch((e) => {
  console.error("selfcheck FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
