# Job Attribution, Cancel and Notify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a background job the chat that started it, the ability to be stopped, and a way to say it finished.

**Architecture:** The tool contract gains one optional context argument carrying the calling agent's session id, supplied at the single `safeRun` chokepoint — an argument down the call stack rather than ambient state, because several chats now stream at once. `Job` gains `sessionId`, a fourth `"cancelled"` status, and an in-memory abort handle. The app scopes the jobs section, adds a cancel control, and counts jobs in the chip that already exists.

**Tech Stack:** TypeScript on Node (engine, `tsx`); vanilla ES modules + Electron (app). No new dependencies.

## Global Constraints

- **Two repos.** Tasks 1–3 in `C:\Users\ADMIN\Desktop\ada\cos0`. Tasks 4–5 in `C:\Users\ADMIN\Desktop\ada\ada-app`. **Engine first** — the app reads fields the engine has to produce.
- **No new dependencies** in either repo.
- **No changes to `spawn_agent`, to fan-out, or to `subagentModel`.** Those work.
- **No cross-project job view, no persisted seen-state, no OS/toast notifications.** Out of scope.
- **The abort handle is never persisted.** `Job` is serialised to `.ada/jobs.json`; an `AbortController` means nothing after a restart.
- Comment style in both repos: explain **why**, not **what**, in full sentences. Deliberate simplifications carry a `ponytail:` prefix.
- Prettier the `ada-app` files you touch before committing.

## Sensors — measured on the merged mains, not guessed

**`cos0`** — branch off `main` (`7bf64fe`):

| Command | Baseline | Gate |
| --- | --- | --- |
| `npm run selfcheck` | `selfcheck OK` | must stay OK |
| `npm run typecheck` | **0 errors — completely clean** | must stay 0 |

There is no `npm test` in `cos0`. Its typecheck being clean means any type error you introduce is unambiguously yours.

**`ada-app`** — branch off `main` (`7888f7a`):

| Command | Baseline | Gate |
| --- | --- | --- |
| `npm run lint` | clean | must stay clean |
| `npm test` | **108 pass, 0 fail** | must stay 108 pass, 0 fail |
| `npm run typecheck` | **80 errors, pre-existing** | must not exceed 80 |
| `npm run build` | succeeds | must keep succeeding |

`ada-app`'s 80 errors sit in `electron/scheduler.js`, `test/scheduler.test.js`, `src/lib.js`, `electron/procs.js`, `test/tokenkey.test.js`, `test/procs.test.js` and `electron/tokenkey.js`. None in `src/app.js`, which is outside the typechecker's scope entirely. Do not fix them. Count with:

```bash
npm run typecheck 2>&1 | grep -cE "error TS"
```

## The id mismatch you must not trip over

There are **two** session ids in play and they are different values:

- **The app's chat id** — `sess.id`, e.g. `s1723…`. This is what `tasksFilterSess` holds and what `bgTasks` rows carry as `sessId`.
- **The engine's serve-session id** — `newId("sess")`, stored by the app on the chat as `sess.adaSessionId`. **This is what a `Job` will carry.**

So a job belongs to the filtered chat when `job.sessionId === <that chat>.adaSessionId`, never when it equals `tasksFilterSess`. Task 4 spells out the lookup. Comparing the wrong pair silently shows an always-empty section.

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `cos0/src/client/tools.ts` | `ToolCtx`, widened `Tool.run` | 1 |
| `cos0/src/client/agent.ts` | `safeRun` passes ctx; `Agent` takes `sessionId` | 1 |
| `cos0/src/client/cli.ts` | serve passes the id; cancel route | 1, 3 |
| `cos0/src/client/background.ts` | `Job.sessionId`, `"cancelled"`, abort handles | 2, 3 |
| `cos0/src/selfcheck.ts` | assertions for all engine behaviour | 1, 2, 3 |
| `ada-app/electron/main.js` + `preload.js` | `agentJobCancel` IPC | 4 |
| `ada-app/src/app.js` | scoping, cancel control, chip | 4, 5 |

No new files.

---

### Task 1: A tool can learn which session called it

**Files:**
- Modify: `cos0/src/client/tools.ts` (the `Tool` interface)
- Modify: `cos0/src/client/agent.ts` (`safeRun` ~line 608, its call site ~1138, the constructor opts ~678)
- Modify: `cos0/src/client/cli.ts` (`makeSession` ~1090, the id at ~1113)
- Test: `cos0/src/selfcheck.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ToolCtx { sessionId?: string }` from `tools.ts`; `Tool.run(args, ctx?)`; an optional `sessionId` on the `Agent` constructor options. Task 2 reads `ctx?.sessionId` inside `background_task`.

**Nothing observable changes in this task.** No tool reads the context yet. That is expected — Task 2 is the first consumer.

- [ ] **Step 1: Write the failing test**

Append to `cos0/src/selfcheck.ts`, after the existing background-job block:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
npm run typecheck
```

Expected: FAIL — `run` does not accept a second parameter. If it fails for any other reason, stop and report.

- [ ] **Step 3: Widen the tool contract**

In `cos0/src/client/tools.ts`, above the `Tool` interface:

```ts
/** What the calling agent knows about itself, handed to a tool at call time.
 *
 * An argument rather than a module-level "current session", deliberately: several chats stream at
 * once now, so an ambient value would be whichever turn set it last, not the one asking. Optional
 * because most tools neither need nor read it, and an agent outside a serve session has no id. */
export interface ToolCtx {
  sessionId?: string;
}
```

and change the interface's last line from `run(args: Record<string, unknown>): Promise<ToolResult>;` to:

```ts
  run(args: Record<string, unknown>, ctx?: ToolCtx): Promise<ToolResult>;
```

Every existing tool implementation ignores the new parameter — no other file in `tools.ts` changes.

- [ ] **Step 4: Pass it through the chokepoint**

In `cos0/src/client/agent.ts`, `safeRun` becomes:

```ts
async function safeRun(tool: Tool, args: Record<string, unknown>, ctx?: ToolCtx): Promise<ToolResult> {
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return { output: String(e), isError: true };
  }
}
```

Add `type ToolCtx` to the existing `./tools.ts` import at the top of the file.

Its one call site (~line 1138, inside `runTool`) becomes:

```ts
      return afterTool(name, pre.args, await safeRun(tool, pre.args, { sessionId: this.sessionId }));
```

`runTool` is an arrow function inside `execTools`, so `this` is the Agent — verify that before relying on it; if it is not, capture `const sessionId = this.sessionId;` at the top of `execTools` and close over it.

- [ ] **Step 5: Give the Agent its id**

In the constructor options object, after `tokenBudget`:

```ts
    /** The serve session this agent belongs to, when it has one. Handed to tools so a job can record
     *  which chat started it; undefined for the REPL and one-shot CLI, which belong to no chat. */
    sessionId?: string;
```

and beside the other assignments:

```ts
    this.sessionId = opts.sessionId;
```

with a `private sessionId?: string;` field declared alongside `private project: boolean;`.

- [ ] **Step 6: The serve tells it**

In `cos0/src/client/cli.ts`, `makeSession` currently builds the `Agent` and *then* runs `const id = newId("sess");` (~line 1113). Move that line above `rec.agent = new Agent({ … })` and pass it in:

```ts
      const id = newId("sess");
      const rec: AgentSession = { /* …unchanged… */ };
      rec.agent = new Agent({
        client,
        model: m,
        session,
        sessionId: id, // so a background_task started in this chat can record whose it is
        history,
        /* …the rest unchanged… */
      });
```

and delete the old `const id = newId("sess");` further down, keeping the `sessions.set(id, rec); return { id, rec };` lines as they are.

- [ ] **Step 7: Run the sensors**

```bash
npm run typecheck
```

Expected: `0` errors.

```bash
npm run selfcheck
```

Expected: `selfcheck OK`, including the two new assertions.

- [ ] **Step 8: Commit**

```bash
git add src/client/tools.ts src/client/agent.ts src/client/cli.ts src/selfcheck.ts
git commit -m "tools: a tool can learn which session called it"
```

---

### Task 2: A job records whose chat it is

**Files:**
- Modify: `cos0/src/client/background.ts`
- Test: `cos0/src/selfcheck.ts`

**Interfaces:**
- Consumes: `ToolCtx` and `Tool.run(args, ctx?)` from Task 1.
- Produces: `Job.sessionId?: string`; `startJob(task, run, sessionId?)`. Task 4 reads `job.sessionId` over the wire.

- [ ] **Step 1: Write the failing test**

Append to `cos0/src/selfcheck.ts`, after Task 1's block:

```ts
  // --- a job remembers which chat started it -------------------------------------------------
  {
    const { startJob, listJobs, reviveJobs } = await import("./client/background.ts");
    const withId = startJob("attributed job", async () => "done", "sess-xyz");
    const without = startJob("terminal job", async () => "done");
    await new Promise((r) => setTimeout(r, 30));
    const all = listJobs();
    assert.equal(all.find((j) => j.id === withId)?.sessionId, "sess-xyz", "a job records the session that started it");
    assert.equal(all.find((j) => j.id === without)?.sessionId, undefined, "a job with no session is still valid — a terminal agent has none");

    // The field has to survive a restart, or attribution silently resets to unscoped.
    const revived = reviveJobs([{ id: "j99", task: "t", status: "done", result: "r", started: 1, ended: 2, sessionId: "sess-xyz" }]);
    assert.equal(revived.jobs[0]!.sessionId, "sess-xyz", "reviveJobs carries sessionId across a restart");
  }
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
npm run typecheck
```

Expected: FAIL — `startJob` takes 2 arguments, and `sessionId` is not on `Job`.

- [ ] **Step 3: Add the field**

In `cos0/src/client/background.ts`, extend `Job`:

```ts
export interface Job {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  result?: string;
  started: number;
  ended?: number;
  /** The serve session whose chat started this job. Absent for a job started from a terminal, which
   *  belongs to no chat and is only ever listed in the app's unscoped view. */
  sessionId?: string;
}
```

`startJob` gains the parameter and stamps it:

```ts
export function startJob(task: string, run: () => Promise<string>, sessionId?: string): string {
  load();
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now(), sessionId };
```

The rest of `startJob` is unchanged.

- [ ] **Step 4: Carry it across a restart**

`reviveJobs` builds new `Job` objects in two branches. Add `sessionId: j.sessionId` to **both** — the interrupted branch and the normal one. Missing it on the interrupted branch would silently unscope exactly the jobs a crash left behind.

- [ ] **Step 5: The tool passes it**

`background_task`'s `run` gains the context parameter and forwards it:

```ts
    async run(args, ctx) {
      const task = String(args.task ?? "");
      // Mirrors spawn_agent's guard above: an empty reply stored as "" reads as unset to the app
      // (`if (j.result)`), leaving the row silently non-expandable with nothing explaining why.
      const id = startJob(
        task,
        () =>
          sub(true)
            .send(task, { quiet: true, delegated: true })
            .then((text) => text || "(sub-agent returned no text)"),
        ctx?.sessionId,
      );
      return { output: `Started background job ${id}. Check results with /jobs in the terminal, or the Background jobs section in the app (don't wait on it).` };
    },
```

Leave `spawn_agent` alone — it returns to the caller directly and creates no job.

- [ ] **Step 6: Run the sensors**

```bash
npm run typecheck && npm run selfcheck
```

Expected: 0 errors, `selfcheck OK`.

- [ ] **Step 7: Commit**

```bash
git add src/client/background.ts src/selfcheck.ts
git commit -m "jobs: record the chat that started one"
```

---

### Task 3: Cancel a running job

**Files:**
- Modify: `cos0/src/client/background.ts`
- Modify: `cos0/src/client/cli.ts` (a route beside `/v1/jobs`)
- Test: `cos0/src/selfcheck.ts`

**Interfaces:**
- Consumes: `Job` and `startJob` from Task 2.
- Produces: `export function cancelJob(id: string): Job | null`; `Job["status"]` gains `"cancelled"`; `POST /v1/jobs/:id/cancel` → `{ job }` or 404. Task 4 calls the route.

- [ ] **Step 1: Write the failing test**

Append to `cos0/src/selfcheck.ts`:

```ts
  // --- cancelling a running job --------------------------------------------------------------
  {
    const { startJob, cancelJob, listJobs, reviveJobs } = await import("./client/background.ts");
    // A job that only settles when its signal fires, so the test controls exactly when it ends.
    const id = startJob("cancel me", (signal) => new Promise<string>((_res, rej) => {
      signal?.addEventListener("abort", () => rej(new Error("aborted")));
    }));
    const j = cancelJob(id);
    assert.equal(j?.status, "cancelled", "cancelJob settles the job as cancelled");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(listJobs().find((x) => x.id === id)?.status, "cancelled", "and the rejection does not overwrite it with error");

    assert.equal(cancelJob("j-nope"), null, "cancelling an unknown job is null, not a throw");
    const settled = startJob("already done", async () => "fine");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cancelJob(settled)?.status, "done", "cancelling a settled job is a no-op, not an error");

    // Without this, a restart relabels a deliberate stop as a success — the coercion sends anything
    // unrecognised to "done".
    const revived = reviveJobs([{ id: "j98", task: "t", status: "cancelled", started: 1, ended: 2 }]);
    assert.equal(revived.jobs[0]!.status, "cancelled", "reviveJobs preserves cancelled rather than coercing it to done");
  }
```

Note the test passes a `signal` into `startJob`'s runner. That changes `startJob`'s second parameter from `() => Promise<string>` to `(signal?: AbortSignal) => Promise<string>` — Step 3 does that.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run typecheck
```

Expected: FAIL — `cancelJob` is not exported, and `"cancelled"` is not a valid status.

- [ ] **Step 3: Implement**

In `cos0/src/client/background.ts`:

Widen the status union on `Job`:

```ts
  status: "running" | "done" | "error" | "cancelled";
```

Add the handle map beside the `jobs` Map:

```ts
/** Abort handles for jobs still running, keyed by job id.
 *
 * Deliberately NOT a field on `Job`: that record is serialised to .ada/jobs.json, and a controller
 * means nothing once the process that owned it is gone. Dropped as soon as a job settles. */
const aborts = new Map<string, AbortController>();
```

`startJob` creates one, hands its signal to the runner, and clears it on settle:

```ts
export function startJob(task: string, run: (signal?: AbortSignal) => Promise<string>, sessionId?: string): string {
  load();
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now(), sessionId };
  jobs.set(id, job);
  const ac = new AbortController();
  aborts.set(id, ac);
  save();
  const settle = (status: Job["status"], result: string): void => {
    aborts.delete(id);
    // cancelJob already wrote "cancelled"; the runner's own rejection arrives moments later and must
    // not relabel a deliberate stop as a crash.
    if (job.status !== "running") return;
    job.status = status;
    job.result = result;
    job.ended = Date.now();
    save();
  };
  run(ac.signal).then(
    (r) => settle("done", r),
    (e) => settle("error", e instanceof Error ? e.message : String(e)),
  );
  return id;
}
```

And the canceller:

```ts
/** Stop a running job. Returns the job in its new state, or null if there is no such job.
 *
 * Cancelling something that already finished is a no-op success rather than an error: the user
 * clicked a button that raced the job settling, which is not a failure worth reporting. */
export function cancelJob(id: string): Job | null {
  load();
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status !== "running") return job;
  aborts.get(id)?.abort();
  aborts.delete(id);
  job.status = "cancelled";
  job.result = job.result || "cancelled";
  job.ended = Date.now();
  save();
  return job;
}
```

Teach `reviveJobs` the new status — its coercion line becomes:

```ts
      const status: Job["status"] =
        j.status === "running" ? "running" : j.status === "error" ? "error" : j.status === "cancelled" ? "cancelled" : "done";
```

Trimming needs no change, but confirm why rather than assuming: `prune()` delegates to `capJobs`, which splits on `j.status === "running"` and never trims that group. A cancelled job falls in the `finished` half and becomes eligible for trimming, which is correct — it has settled. Read `capJobs` and check that holds before moving on.

- [ ] **Step 4: Add the route**

In `cos0/src/client/cli.ts`, immediately after the existing `GET /v1/jobs` block (~line 1149):

```ts
      const cancelJobMatch = req.method === "POST" && url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (cancelJobMatch) {
        const job = cancelJob(cancelJobMatch[1]!);
        if (!job) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no such job" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ job }));
        return;
      }
```

Add `cancelJob` to the existing `./background.ts` import at the top of the file — it already imports `listJobs, registerSubagentTools, renderJobs`.

- [ ] **Step 5: Run the sensors**

```bash
npm run typecheck && npm run selfcheck
```

Expected: 0 errors, `selfcheck OK`.

Then exercise the route against a real serve:

```bash
ADA_HTTP_PORT=8799 npx tsx src/client/cli.ts serve
```

In another shell:

```bash
curl -s -X POST http://localhost:8799/v1/jobs/j-nope/cancel
```

Expected: `{"error":"no such job"}` with a 404. Stop the serve afterwards, and delete any `.ada/jobs.json` the run created.

- [ ] **Step 6: Commit**

```bash
git add src/client/background.ts src/client/cli.ts src/selfcheck.ts
git commit -m "jobs: cancel a running one, and say cancelled rather than error"
```

---

### Task 4: Scope the section, and add a cancel control

**Files:**
- Modify: `ada-app/electron/main.js` (beside the `agent:jobs` handler)
- Modify: `ada-app/electron/preload.js`
- Modify: `ada-app/src/app.js` (the `window.ada` stub ~line 170; `renderTasksPanel`'s jobs block ~852)
- Modify: `ada-app/src/style.css`

**Interfaces:**
- Consumes: `job.sessionId` and `job.status === 'cancelled'` from Tasks 2–3; `POST /v1/jobs/:id/cancel`.
- Produces: `window.ada.agentJobCancel(dir, id) -> { ok, job? , error? }`. Task 5 consumes nothing from this task beyond the scoping helper.

**The id lookup — read this before writing the scoping code.** `tasksFilterSess` holds the app's chat id (`sess.id`). A job carries the *engine's* session id. The chat that owns a job is the one whose `adaSessionId` matches. So:

```js
  // tasksFilterSess is a CHAT id; a job carries the ENGINE's session id, which the chat stores as
  // adaSessionId. Comparing the two directly would match nothing and show an always-empty section.
  const filterAda = tasksFilterSess ? sessions.find((s) => s.id === tasksFilterSess)?.adaSessionId : null;
  const jobsInScope = (j) => !tasksFilterSess || (!!filterAda && j.sessionId === filterAda);
```

`sessions` is declared at `src/app.js:3297`, well below `renderTasksPanel` — that is fine and not a bug. It is a module-level `let`, and `renderTasksPanel` only ever runs after module initialisation, so the binding is live by then. Do not move the declaration or add a parameter to work around it.

- [ ] **Step 1: Add the cancel IPC**

In `ada-app/electron/main.js`, immediately after the `agent:jobs` handler:

```js
// Stop a running background job. Like agent:jobs, this never starts a serve — with no serve there is
// no job to cancel, and booting an agent to answer a stop request would be absurd.
ipcMain.handle('agent:jobCancel', async (_e, { dir, id }) => {
  const s = serves.get(dir);
  if (!s) return { ok: false, error: 'no agent running for this folder' };
  try {
    const r = await fetch(`http://localhost:${s.port}/v1/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, job: j.job };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
```

In `ada-app/electron/preload.js`, beneath `agentJobs`:

```js
  agentJobCancel: (dir, id) => ipcRenderer.invoke('agent:jobCancel', { dir, id }),
```

In `ada-app/src/app.js`'s `window.ada` stub, beneath `agentJobs`:

```js
    agentJobCancel: async () => ({ ok: false, error: 'no agent in browser preview' }),
```

- [ ] **Step 2: Scope the section**

In `renderTasksPanel`, replace the jobs block's opening comment and loop header. The old comment says jobs "are not per-chat — the engine registers the tool once per serve and a job never learns which conversation started it." That is no longer true and must go.

```js
  // Background jobs: `background_task` spawns these and the agent owns them, so they are not in
  // bgTasks. They carry the engine's session id, which a chat stores as adaSessionId — so the
  // section filters with the panel like the rows above it, and unattributed jobs (started from a
  // terminal, belonging to no chat) appear only in the unscoped view.
  const filterAda = tasksFilterSess ? sessions.find((s) => s.id === tasksFilterSess)?.adaSessionId : null;
  const jobsInScope = (j) => !tasksFilterSess || (!!filterAda && j.sessionId === filterAda);
  const shownJobs = jobsCache.filter(jobsInScope);
  const jobsHost = $('tp-jobs');
  jobsHost.innerHTML = '';
  $('tp-jobs-head').classList.toggle('hidden', !shownJobs.length);
  for (const j of shownJobs) {
```

The body of the loop is unchanged except for Step 3.

- [ ] **Step 3: Add the cancel control**

Inside the loop, after the `.tp-age` line and before `wrap.appendChild(el)`:

```js
    // Only a running job can be stopped, and only the row's own button does it — the rest of the
    // row is the expand target.
    if (j.status === 'running') {
      const stop = document.createElement('button');
      stop.className = 'tp-cancel';
      stop.title = 'Stop this job';
      stop.textContent = '✕';
      stop.onclick = async (e) => {
        // Same reason the expand handler stops propagation: this row rebuilds itself, which detaches
        // the click target, and the document-level handler would then read the click as outside the
        // panel and close it.
        e.stopPropagation();
        stop.disabled = true;
        await window.ada.agentJobCancel(agentCwd, j.id);
        jobsFetchAt = 0; // show the result of the stop now rather than up to 3s later
        await refreshJobs();
        renderTasksPanel();
      };
      el.appendChild(stop);
    }
```

- [ ] **Step 4: Style it**

In `ada-app/src/style.css`, after the `.tp-result` rules:

```css
/* Sits in the row's flex line beside the age, not in the wrapper — stopping a job is an action on
   the row, while the result below it is the row's content. */
.tp-cancel {
  flex: none;
  margin-left: 6px;
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--color-neutral-600);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}
.tp-cancel:hover {
  color: var(--color-text);
}
.tp-cancel:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 5: Verify**

```bash
npm run lint && npm test && npm run build
```

Expected: lint clean, 108 tests 0 fail, build succeeds.

```bash
npm run typecheck 2>&1 | grep -cE "error TS"
```

Expected: `80`.

Then in the browser preview (`npx vite --port 5173`), mock the IPC from devtools and drive it:

```js
window.ada.agentJobs = async () => ({ ok: true, jobs: [
  { id: 'j1', task: 'mine', status: 'done', result: 'readable', started: Date.now() - 9000, ended: Date.now() - 1000, sessionId: 'sess-a' },
  { id: 'j2', task: 'someone else\u2019s', status: 'running', started: Date.now() - 3000, sessionId: 'sess-b' },
  { id: 'j3', task: 'from a terminal', status: 'done', result: 'x', started: Date.now() - 8000, ended: Date.now() - 2000 },
]});
```

Open the panel unscoped: expected **three** rows, and the running one carries a ✕. Then open it scoped to a chat (click a chat's tasks chip) — expected only that chat's jobs, and none if its `adaSessionId` matches nothing. Confirm the panel stays open when you click ✕ and when you expand a result.

If you cannot drive the preview, say so plainly rather than claiming you did.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/app.js src/style.css electron/main.js electron/preload.js
git add src/app.js src/style.css electron/main.js electron/preload.js
git commit -m "jobs: scope the panel section per chat, and let a running job be stopped"
```

---

### Task 5: Say when one finishes

**Files:**
- Modify: `ada-app/src/app.js` (`renderChatTasksChip` ~783; `toggleTasksPanel` ~899)

**Interfaces:**
- Consumes: `jobsCache`, `job.sessionId`, `job.ended` from Task 4.
- Produces: nothing.

The chip currently counts only this chat's running `bgTasks`. Jobs have never been in it — which is why a job could start, run and finish with no indication anywhere unless the panel happened to be open.

- [ ] **Step 1: Track when the jobs were last seen**

Beside `jobsOpen`:

```js
// When the panel was last opened. A job that ended after this is one the user has not seen, which is
// the whole notification: the chip says so, and opening the panel clears it by moving the mark.
// ponytail: not persisted — a restart re-announcing a finished job is the harmless direction to fail.
let jobsSeenAt = Date.now();
```

In `toggleTasksPanel`'s opening branch, beside `jobsFetchAt = 0;`:

```js
    jobsSeenAt = Date.now(); // opening the panel is what "seeing" them means
```

- [ ] **Step 2: Count jobs in the chip**

Replace `renderChatTasksChip` with:

```js
function renderChatTasksChip() {
  const chip = $('cs-tasks');
  if (!chip) return;
  const ada = current?.adaSessionId;
  const mine = [...bgTasks.running.values()].filter((t) => t.sessId === current?.id).length;
  // Jobs belong to a chat by the ENGINE's session id, which this chat stores as adaSessionId.
  const jobsMine = ada ? jobsCache.filter((j) => j.sessionId === ada) : [];
  const running = mine + jobsMine.filter((j) => j.status === 'running').length;
  const finished = jobsMine.filter((j) => j.status !== 'running' && (j.ended || 0) > jobsSeenAt).length;
  chip.classList.toggle('hidden', !running && !finished);
  // Two different things to say, and the finished one wins: a count that only ever goes up and down
  // never tells you a job is DONE, which is the thing you were waiting for.
  chip.textContent = finished
    ? `${finished} job${finished === 1 ? '' : 's'} finished`
    : `${running} running task${running === 1 ? '' : 's'}`;
}
```

- [ ] **Step 3: Repaint the chip when jobs change**

`refreshJobs` currently repaints only the panel when `jobsCache` changes. The chip depends on `jobsCache` too, so add it beside that call:

```js
    jobsCache = next;
    renderChatTasksChip();
    if (!$('tasks-panel').classList.contains('hidden')) renderTasksPanel();
```

**But `refreshJobs` only runs while the panel is open** — so with the panel shut, nothing fetches and the chip can never learn a job finished. That defeats the feature. Add a slow background poll that runs regardless, near where `jobsSeenAt` is declared:

```js
// The panel's own tick only runs while it is open, so without this the chip could never learn that
// a job finished — which is exactly the case the chip exists for. Slow on purpose: this is a badge,
// not a live view, and refreshJobs is self-throttled anyway.
setInterval(() => {
  if ($('tasks-panel').classList.contains('hidden')) refreshJobs().catch(() => {});
}, 15000);
```

- [ ] **Step 4: Verify**

```bash
npm run lint && npm test && npm run build
```

Expected: lint clean, 108 tests 0 fail, build succeeds.

```bash
npm run typecheck 2>&1 | grep -cE "error TS"
```

Expected: `80`.

In the preview, with a chat whose `adaSessionId` you can read from devtools, mock `agentJobs` to return a finished job for that session with `ended` in the future relative to the last panel open, and confirm the chip reads `1 job finished`. Open the panel and confirm it reverts to the running count. If you cannot drive it, say so.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/app.js
git add src/app.js
git commit -m "tasks chip: count background jobs, and say when one has finished"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `ToolCtx`, widened `Tool.run` | 1 |
| `safeRun` supplies the ctx | 1 |
| `Agent` gains `sessionId`; serve passes it | 1 |
| REPL/CLI agents leave it undefined | 1 (no change to those call sites) |
| `Job.sessionId`, carried by `reviveJobs` | 2 |
| `background_task` forwards `ctx?.sessionId` | 2 |
| Abort handle in memory, never persisted | 3 (`aborts` Map) |
| `SendCtrl.signal` used | 3 (runner takes the signal) |
| Fourth `"cancelled"` status | 3 |
| `reviveJobs` preserves it rather than coercing to `done` | 3 (tested) |
| Cancel of a settled job is a no-op success | 3 (tested) |
| Cancel of an unknown id is 404 | 3 |
| `POST /v1/jobs/:id/cancel` | 3 |
| `agentJobCancel` IPC | 4 |
| Section scoped per chat; unattributed only in the unscoped view | 4 |
| Cancel control on running rows | 4 |
| Chip counts this chat's running jobs | 5 |
| `jobsSeenAt`, unseen finishes, cleared on open | 5 |
| No persisted seen-state | 5 (`ponytail:` note) |

No gaps. One thing the spec did not anticipate and this plan adds: Task 5 Step 3's background poll. The spec said polling stops when the panel closes, which is right for the panel — but the chip needs *some* signal or it can never report a finish. A 15s poll while closed is the smallest thing that makes the feature work.

**Placeholder scan:** none. Every code step carries the code. Two steps say "verify X before relying on it" (`this` inside `runTool`; `prune()`'s treatment of a cancelled job) — those are read-before-edit instructions with the specific thing to check named, not deferred decisions.

**Type consistency:** `ToolCtx` is defined in Task 1 and consumed in Tasks 1–2 by that name. `startJob(task, run, sessionId?)` with `run: (signal?: AbortSignal) => Promise<string>` is settled in Task 3 and used with that shape there; Task 2 introduces the third parameter and Task 3 changes the second — the tasks are ordered so Task 3's test is the first to pass a signal. `cancelJob(id): Job | null` is defined in Task 3 and called by the route in the same task. `agentJobCancel(dir, id) -> { ok, job?, error? }` is defined in Task 4 and used only there.

## Known rough edges

- Task 3's `settle` guard means a runner that rejects *after* a cancel is silently discarded. That is the point, but it also means a runner rejecting for an unrelated reason moments after a cancel loses its message.
- The 15s closed-panel poll runs for the app's whole life once wired. It is one `fetch` to localhost every 15s, self-throttled, and returns an empty list when no serve is up.
