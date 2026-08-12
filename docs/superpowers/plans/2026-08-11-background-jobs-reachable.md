# Background Jobs You Can Actually Read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the result of `background_task` reachable from the Ada app, and let jobs survive an `ada serve` restart.

**Architecture:** The engine's in-memory job `Map` gains a `.ada/jobs.json` backing and a structured `listJobs()` accessor; `ada serve` exposes it at `GET /v1/jobs`; the app fetches that through a new IPC and renders a "Background jobs" section in the tasks panel it already has. The load path is factored into one pure function so the interesting behaviour is testable without a filesystem.

**Tech Stack:** TypeScript on Node (engine, `tsx`, `node:fs`); vanilla ES modules + Electron (app). No new dependencies in either repo.

## Global Constraints

- **Two repos.** Tasks 1–2 are in `C:\Users\ADMIN\Desktop\ada\cos0` (the `ada-agent` engine). Tasks 3–4 are in `C:\Users\ADMIN\Desktop\ada\ada-app`. **Land the engine first** — Task 3 calls the endpoint Task 2 creates.
- **No new dependencies** in either repo.
- **No changes to `spawn_agent`, to parallel fan-out, or to `subagentModel`.** Those work; this plan only makes results reachable.
- **No per-chat attribution of jobs**, no cancel button, no completion notification. All explicitly out of scope.
- **Persistence failure is never fatal.** Unreadable, corrupt, or unwritable `jobs.json` degrades to today's in-memory behaviour. Every disk touch is wrapped.
- **Cap the store at 50 jobs**, newest first, pruned on save.
- Comment style in both repos: explain **why**, not **what**, in full sentences. Deliberate simplifications carry a `ponytail:` prefix.

## Sensors

**`cos0` has no `npm test`.** Its sensors are:

| Command | Purpose |
| --- | --- |
| `npm run selfcheck` | `tsx src/selfcheck.ts` — where the existing job test lives |
| `npm run typecheck` | `tsc --noEmit` |

Both measured on the branch points, not guessed:

**`cos0`** — branch `background-jobs`, off `main`:

| Command | Baseline | Gate |
| --- | --- | --- |
| `npm run selfcheck` | `selfcheck OK` | must stay OK |
| `npm run typecheck` | **0 errors — clean** | must stay 0 |

**`ada-app`** — branch `background-jobs-ui`, off `main` (`29afd8b`):

| Command | Baseline | Gate |
| --- | --- | --- |
| `npm run lint` | clean | must stay clean |
| `npm test` | **104 pass, 0 fail** | must stay 104 pass, 0 fail |
| `npm run typecheck` | **80 errors, pre-existing** | must not exceed 80 |
| `npm run build` | succeeds | must keep succeeding |

`cos0` is the strict one: **its typecheck is completely clean**, so any type error you introduce is unambiguously yours. `ada-app`'s 80 pre-existing errors sit in `electron/scheduler.js` (16), `test/scheduler.test.js` (38), `src/lib.js` (9), `electron/procs.js` (5), `test/tokenkey.test.js` (5), `test/procs.test.js` (4) and `electron/tokenkey.js` (3) — none in `src/app.js`, which is outside the typechecker's scope entirely. Do not fix any of them.

Count `ada-app`'s with:

```bash
npm run typecheck 2>&1 | grep -cE "error TS"
```

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `cos0/src/client/background.ts` | Jobs: the store, its disk backing, the two delegation tools | 1 |
| `cos0/src/client/settings.ts` | Add `jobs.json` to the `.ada/.gitignore` list | 1 |
| `cos0/src/selfcheck.ts` | Tests for the pure load path | 1 |
| `cos0/src/client/cli.ts` | `GET /v1/jobs` | 2 |
| `ada-app/electron/main.js` + `preload.js` | `agentJobs(dir)` IPC | 3 |
| `ada-app/src/app.js` | The panel section | 4 |

No new files. `background.ts` is 108 lines and grows to roughly 180 — still one clear responsibility.

---

### Task 1: Persist jobs, and survive a restart

**Files:**
- Modify: `cos0/src/client/background.ts`
- Modify: `cos0/src/client/settings.ts` (the `ensureAdaDir` gitignore list)
- Test: `cos0/src/selfcheck.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface Job { id, task, status, result?, started, ended? }`; `export function reviveJobs(raw: unknown): { jobs: Job[]; nextSeq: number }`; `export function listJobs(): Job[]`. Task 2 calls `listJobs()`. `renderJobs()` keeps its existing signature `(): string`.

**Why the load path is a separate pure function:** everything worth testing about loading — rewriting stale `running` jobs, continuing the id sequence, ignoring junk — is a transformation of parsed JSON. Putting it in `reviveJobs` means the tests need no filesystem, no temp directory, and no `process.cwd()` juggling. The disk read is then a three-line wrapper with nothing to get wrong.

- [ ] **Step 1: Write the failing tests**

In `cos0/src/selfcheck.ts`, find the existing block:

```ts
  // --- background job runs and reports ---
  const jid = startJob("selfcheck job", async () => "job-done-ok");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(renderJobs().includes(jid) && /job-done-ok/.test(renderJobs()), "background job runs and reports its result");
```

Add immediately after it:

```ts
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
  }
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
npm run selfcheck
```

Expected: FAIL — `reviveJobs` is not exported from `./client/background.ts`. If it fails for any other reason, stop and report.

- [ ] **Step 3: Write the implementation**

In `cos0/src/client/background.ts`, replace the file's opening comment and the `Job`/`jobs`/`seq`/`startJob` block.

The header comment currently ends with `ponytail: in-memory, single process — jobs vanish on exit.` — that is no longer true. Rewrite the first paragraph to:

```ts
// Fire-and-forget background jobs: kick off a long, independent subtask without blocking the main
// loop; read results later with /jobs in the terminal, or the app's Background jobs section.
// Persisted to .ada/jobs.json so a result outlives the `ada serve` that produced it — the app had
// no way to reach one at all before, and a restart used to throw away every finished job.
```

Add the imports it needs, beside the existing ones:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureAdaDir } from "./settings.ts";
```

Then:

```ts
export interface Job {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  result?: string;
  started: number;
  ended?: number;
}

/** Newest first, and only this many — a job log is a convenience, not an audit trail. */
const CAP = 50;

const storePath = (): string => resolve(process.cwd(), ".ada", "jobs.json");

/**
 * Rebuild the job list from whatever was on disk.
 *
 * Pure on purpose: every rule that matters when loading lives here, and none of them needs a
 * filesystem to test. The disk read below is then a wrapper with nothing to get wrong.
 *
 * Two of these rules are not optional. A job still marked `running` belonged to a process that no
 * longer exists, so it can never transition — loading it as-is shows a job running forever. And the
 * id counter has to continue from what was loaded, or the next `startJob` reuses `j1` and
 * overwrites the persisted `j1`, destroying exactly the result persistence was added to keep.
 */
export function reviveJobs(raw: unknown): { jobs: Job[]; nextSeq: number } {
  if (!Array.isArray(raw)) return { jobs: [], nextSeq: 0 };
  const jobs: Job[] = [];
  let nextSeq = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const j = r as Partial<Job>;
    if (typeof j.id !== "string" || typeof j.task !== "string" || typeof j.started !== "number") continue;
    const n = Number(j.id.replace(/^j/, ""));
    if (Number.isFinite(n) && n > nextSeq) nextSeq = n;
    jobs.push(
      j.status === "running"
        ? { id: j.id, task: j.task, status: "error", result: "interrupted — ada serve restarted", started: j.started, ended: Date.now() }
        : { id: j.id, task: j.task, status: j.status === "error" ? "error" : "done", result: j.result, started: j.started, ended: j.ended },
    );
  }
  return { jobs, nextSeq };
}

const jobs = new Map<string, Job>();
let seq = 0;
let loaded = false;

/** Read the store once, on first use. A missing, unreadable or corrupt file is not an error: jobs
 *  fall back to memory-only, which is exactly how they behaved before they were persisted. */
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const p = storePath();
    if (!existsSync(p)) return;
    const { jobs: list, nextSeq } = reviveJobs(JSON.parse(readFileSync(p, "utf8")));
    for (const j of list) jobs.set(j.id, j);
    seq = nextSeq;
  } catch (e) {
    console.error(`jobs: could not read the job store, starting empty (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Whole-file write on every status change — three writes per job, of a file capped at 50 entries.
 *  A read-only checkout just keeps its jobs in memory. */
function save(): void {
  try {
    const dir = resolve(process.cwd(), ".ada");
    ensureAdaDir(dir);
    writeFileSync(join(dir, "jobs.json"), JSON.stringify(listJobs(), null, 2));
  } catch {
    /* not writable — jobs still work, they just will not outlive this process */
  }
}

/** Every job this project knows about, newest first. */
export function listJobs(): Job[] {
  load();
  return [...jobs.values()].sort((a, b) => b.started - a.started).slice(0, CAP);
}
```

Then rewrite `startJob` to load first, stamp `ended`, and save at each transition:

```ts
/** Start `run()` in the background; returns a job id immediately. */
export function startJob(task: string, run: () => Promise<string>): string {
  load();
  const id = `j${++seq}`;
  const job: Job = { id, task, status: "running", started: Date.now() };
  jobs.set(id, job);
  save();
  run().then(
    (r) => {
      job.status = "done";
      job.result = r;
      job.ended = Date.now();
      save();
    },
    (e) => {
      job.status = "error";
      job.result = e instanceof Error ? e.message : String(e);
      job.ended = Date.now();
      save();
    },
  );
  return id;
}
```

Finally, reimplement `renderJobs` over `listJobs` so the CLI and the endpoint cannot drift:

```ts
export function renderJobs(): string {
  const all = listJobs();
  if (!all.length) return "(no background jobs)";
  return all
    .map((j) => `${j.id} [${j.status}] ${j.task.slice(0, 60)}${j.result && j.status !== "running" ? `\n   → ${j.result.slice(0, 240)}` : ""}`)
    .join("\n");
}
```

- [ ] **Step 4: Keep the store out of the user's git status**

In `cos0/src/client/settings.ts`, `ensureAdaDir` writes a `.gitignore` inside `.ada/` listing the machine-generated caches. Add `jobs.json` to that array, after `index.vec`:

```ts
          "graph.db",
          "jobs.json",
          "sessions/",
```

This matters: Ada writes into whatever repo the user opens. The list is deliberately not a blanket `*` because `memory/` and `skills/` are meant to be committed — `jobs.json` is a local cache and belongs with the ignored ones.

- [ ] **Step 5: Run the tests**

```bash
npm run selfcheck
```

Expected: PASS, including the pre-existing `background job runs and reports its result`.

```bash
npm run typecheck
```

Expected: whatever baseline you recorded before starting, unchanged.

Then confirm the round trip by hand, since the disk wrapper is the part `reviveJobs` cannot cover:

```bash
node -e "process.chdir(process.cwd())" && npx tsx -e "
import { startJob, listJobs } from './src/client/background.ts';
startJob('manual check', async () => 'persisted-ok');
setTimeout(() => { console.log(JSON.stringify(listJobs(), null, 2)); }, 50);
"
cat .ada/jobs.json
```

Expected: the job appears in both, with `status: "done"` and `result: "persisted-ok"`. Then run the same snippet again and confirm the new job gets `j2`, not `j1`, and the first job is still there. **Delete `.ada/jobs.json` afterwards** so you do not commit a scratch file.

- [ ] **Step 6: Commit**

```bash
git add src/client/background.ts src/client/settings.ts src/selfcheck.ts
git commit -m "jobs: persist to .ada/jobs.json so a result outlives the serve that made it"
```

---

### Task 2: Serve the jobs over HTTP

**Files:**
- Modify: `cos0/src/client/cli.ts`

**Interfaces:**
- Consumes: `listJobs()` from Task 1.
- Produces: `GET /v1/jobs` → `{ jobs: Job[] }`. Task 3 calls it.

- [ ] **Step 1: Add the route**

In `cos0/src/client/cli.ts`, find the existing sessions route inside the serve request handler:

```ts
      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: list() }));
        return;
      }
```

Add immediately after it:

```ts
      // Background jobs, so the editor can show what `background_task` produced. The CLI reads the
      // same list through /jobs; without this route the app started jobs it could never read back.
      if (req.method === "GET" && url.pathname === "/v1/jobs") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jobs: listJobs() }));
        return;
      }
```

Add `listJobs` to the existing import of `./background.ts` at the top of the file. Find that import first — `background.ts` is already imported for `registerSubagentTools` and `renderJobs`.

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

Expected: your recorded baseline, unchanged.

```bash
npm run selfcheck
```

Expected: PASS.

Then start a serve and hit the route:

```bash
ADA_HTTP_PORT=8799 npx tsx src/client/cli.ts serve
```

In another shell:

```bash
curl -s http://localhost:8799/v1/jobs
```

Expected: `{"jobs":[]}` on a clean project, or your jobs if `.ada/jobs.json` has any. Stop the serve afterwards.

- [ ] **Step 3: Commit**

```bash
git add src/client/cli.ts
git commit -m "serve: GET /v1/jobs, so the editor can read what background_task produced"
```

---

### Task 3: Reach the endpoint from the app

**Files:**
- Modify: `ada-app/electron/main.js`
- Modify: `ada-app/electron/preload.js`

**Interfaces:**
- Consumes: `GET /v1/jobs` from Task 2.
- Produces: `window.ada.agentJobs(dir) -> Promise<{ ok: boolean, jobs: Job[] }>`. Task 4 calls it. A `Job` is `{ id, task, status: 'running'|'done'|'error', result?, started, ended? }`.

- [ ] **Step 1: Add the IPC handler**

In `ada-app/electron/main.js`, find the existing `agent:serve` handler:

```js
ipcMain.handle('agent:serve', async (_e, { dir, cliPath, backend, extraDirs }) => {
```

Add immediately before it:

```js
// Background jobs from the serve for this folder. Deliberately does NOT start a serve: the panel
// polls this while it is open, and booting an agent because someone opened a panel would be a
// surprise. No serve yet simply means no jobs to show.
ipcMain.handle('agent:jobs', async (_e, dir) => {
  const s = serves.get(dir);
  if (!s) return { ok: true, jobs: [] };
  try {
    const r = await fetch(`http://localhost:${s.port}/v1/jobs`);
    if (!r.ok) return { ok: false, jobs: [], error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, jobs: Array.isArray(j.jobs) ? j.jobs : [] };
  } catch (err) {
    return { ok: false, jobs: [], error: String(err.message || err) };
  }
});
```

- [ ] **Step 2: Expose it on the preload bridge**

In `ada-app/electron/preload.js`, find the `agentServe` line and add beneath it:

```js
  agentJobs: (dir) => ipcRenderer.invoke('agent:jobs', dir),
```

- [ ] **Step 3: Add it to the browser-preview stub**

`ada-app/src/app.js` ships a `window.ada` stub (around line 70) so the renderer runs under plain Vite with no Electron. Every method the app calls must exist there or the preview throws. Find a neighbouring stub such as `agentServe: async () => ({ ok: false, error: 'no agent in browser preview' }),` and add:

```js
    agentJobs: async () => ({ ok: true, jobs: [] }), // no serve in the browser preview
```

- [ ] **Step 4: Verify**

```bash
npm run lint && npm run build
```

Expected: lint clean, build succeeds.

```bash
npm test
```

Expected: 104 pass, 0 fail.

Then in the browser preview (`npx vite --port 5173`), open devtools and run:

```js
await window.ada.agentJobs('/anything');
```

Expected: `{ ok: true, jobs: [] }` — proving the stub is wired and the renderer will not throw.

- [ ] **Step 5: Commit**

```bash
npx prettier --write electron/main.js electron/preload.js src/app.js
git add electron/main.js electron/preload.js src/app.js
git commit -m "ipc: agentJobs(dir) — read background jobs off the running serve"
```

---

### Task 4: Show them in the tasks panel

**Files:**
- Modify: `ada-app/src/app.js`
- Modify: `ada-app/index.html`
- Modify: `ada-app/src/style.css`

**Interfaces:**
- Consumes: `window.ada.agentJobs(dir)` from Task 3.
- Produces: nothing.

**Where this goes:** the app already has a tasks panel — `renderTasksPanel()` with `tp-row` rows, a running section (`#tp-running`) and a finished one (`#tp-finished`). Jobs get a third section below those. It is **unscoped**: `registerSubagentTools` is called once at serve startup with no session context, so a job has no idea which chat spawned it. The heading says so, rather than letting it look like a broken filter.

- [ ] **Step 1: Add the markup**

In `ada-app/index.html`, the tasks panel sections are at lines 447–450:

```html
      <div class="tp-sub">Running</div>
      <div id="tp-running"></div>
      <div class="tp-sub hidden" id="tp-finished-head">Finished</div>
      <div id="tp-finished"></div>
```

Add directly after, at the same six-space indentation and reusing the same `tp-sub` heading class:

```html
      <div class="tp-sub hidden" id="tp-jobs-head">Background jobs</div>
      <div id="tp-jobs"></div>
```

- [ ] **Step 2: Fetch and render the section**

In `ada-app/src/app.js`, add above `renderTasksPanel`:

```js
// Jobs come from the agent, not from this app, so they are fetched rather than tracked. Held here
// between polls so a repaint driven by the 1s tick does not blank the section while a fetch is in
// flight. ponytail: last-fetch-wins, no request id — a stale reply just loses to the next one.
let jobsCache = [];
let jobsFetchAt = 0;

/** Poll the serve for background jobs, at most every 3s. The panel's own tick runs every second
 *  for elapsed times, which is far more often than a job list changes. */
async function refreshJobs() {
  const dir = agentCwd;
  if (!dir || Date.now() - jobsFetchAt < 3000) return;
  jobsFetchAt = Date.now();
  const r = await window.ada.agentJobs(dir);
  const next = r?.jobs ?? [];
  // Only repaint when something actually changed — the panel is redrawn every second anyway.
  if (JSON.stringify(next) !== JSON.stringify(jobsCache)) {
    jobsCache = next;
    if (!$('tasks-panel').classList.contains('hidden')) renderTasksPanel();
  }
}
```

Then, inside `renderTasksPanel()`, after the block that fills `#tp-finished`, add:

```js
  // Background jobs: `background_task` spawns these and the agent owns them, so they are not in
  // bgTasks and they are not per-chat — the engine registers the tool once per serve and a job
  // never learns which conversation started it. The heading says "Background jobs" for that reason.
  const jobsHost = $('tp-jobs');
  jobsHost.innerHTML = '';
  $('tp-jobs-head').classList.toggle('hidden', !jobsCache.length);
  for (const j of jobsCache) {
    const el = document.createElement('div');
    el.className = 'tp-row' + (j.status === 'running' ? ' live' : '');
    el.innerHTML =
      '<i class="tp-dot"></i><span class="tp-main"><b></b><span class="tp-meta"></span></span><span class="tp-age"></span>';
    el.querySelector('b').textContent = j.task;
    el.querySelector('.tp-meta').textContent = j.status === 'running' ? 'background job' : `background job · ${j.status}`;
    el.querySelector('.tp-age').textContent = fmtDur((j.ended || Date.now()) - j.started);
    // The result is the entire point of this section — before it existed, a finished job's answer
    // was unreachable from the app. Click to expand rather than always-on: some are long.
    if (j.result) {
      el.classList.add('tp-open');
      const out = document.createElement('div');
      out.className = 'tp-result hidden';
      out.textContent = j.result;
      el.appendChild(out);
      el.onclick = () => out.classList.toggle('hidden');
    }
    jobsHost.appendChild(el);
  }
```

- [ ] **Step 3: Drive it from the panel's existing tick**

`toggleTasksPanel` already starts a 1s interval while the panel is open. Reuse it rather than adding a second poller. Change its opening branch from:

```js
  if (opening) {
    renderTasksPanel();
    tasksTick = setInterval(renderTasksPanel, 1000); // elapsed times move while it's open
  }
```

to:

```js
  if (opening) {
    jobsFetchAt = 0; // opening the panel always fetches, however recently it last did
    void refreshJobs();
    renderTasksPanel();
    tasksTick = setInterval(() => {
      void refreshJobs(); // self-throttled to 3s; the 1s tick is for the elapsed times
      renderTasksPanel();
    }, 1000);
  }
```

Nothing polls while the panel is shut — `toggleTasksPanel` already clears the interval on close.

- [ ] **Step 4: Style the result block**

In `ada-app/src/style.css`, after the existing `.tp-row` rules, add:

```css
/* A job's result, folded away until asked for. Monospace because it is agent output, not prose,
   and scrollable because a sub-agent's summary can run long. */
.tp-result {
  margin: 6px 0 2px 22px;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-neutral-700);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  border-radius: 6px;
}
.tp-row.tp-open {
  cursor: pointer;
}
```

`--mono` is this stylesheet's monospace variable (defined at `src/style.css:104`, used at 856, 3458, 3505). Do not invent `--font-mono` — it does not exist here.

- [ ] **Step 5: Verify**

```bash
npm run lint && npm run build && npm test
```

Expected: lint clean, build succeeds, 104 tests 0 fail.

```bash
npm run typecheck 2>&1 | grep -cE "error TS"
```

Expected: `80`.

Then the real check, end to end with the actual engine — the preview stub returns an empty list, so it proves only that nothing throws:

1. `npm start` to launch Electron, and open a project folder.
2. Ask Ada: *"start a background task that counts to ten and reports back"* — it should call `background_task`.
3. Open the tasks panel. Expected: a **Background jobs** section with the job, marked running.
4. Wait for it to finish, keeping the panel open. Expected: within ~3s the row stops being live and gains its status.
5. Click the row. Expected: the result text expands — **this is the thing that was previously unreachable.**
6. Quit Ada, relaunch, reopen the same folder and the panel. Expected: the finished job is still listed with its result. Any job that was mid-flight shows as `error — interrupted — ada serve restarted`.

If you cannot run Electron, say so plainly in your report rather than claiming this passed.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/app.js src/style.css
git add src/app.js src/style.css index.html
git commit -m "tasks panel: a Background jobs section, so a job's result is finally readable"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `.ada/jobs.json`, per project | 1 |
| `jobs.json` added to `ensureAdaDir`'s gitignore list | 1 (Step 4) |
| Load on first use, save on every transition | 1 |
| Stale `running` → `error: interrupted — ada serve restarted` | 1 (tested) |
| Id counter seeded from the highest loaded id | 1 (tested) |
| Cap at 50, newest first | 1 (`CAP`, in `listJobs`) |
| `listJobs()` exported; `renderJobs()` a formatter over it | 1 |
| `Job` gains `ended` | 1 |
| I/O failure never fatal | 1 (`load` catches, `save` swallows) |
| `GET /v1/jobs` | 2 |
| `agentJobs(dir)` IPC | 3 |
| Unscoped "Background jobs" section in the existing panel | 4 |
| Fetched on open, polled every 3s while open, stopped on close | 4 (Step 3) |
| Finished row expands to show its result | 4 (Step 2) |
| Three selfcheck additions: round-trip, stale running, id continuation | 1 (Step 1) |
| Engine lands before the app | Global Constraints; Tasks 1–2 precede 3–4 |

No gaps. One deviation worth naming: the spec said "round-trip" as a test, and the tests here cover the round trip's *logic* (`reviveJobs`) purely, with the disk round trip verified by hand in Task 1 Step 5. That is deliberate — a disk test would need `process.cwd()` manipulation inside `selfcheck.ts`, which runs in the repo root and would litter it.

**Placeholder scan:** none. Every code step carries the actual code. Two steps say "find X and copy its class / check Y exists" — those are read-before-edit instructions with the surrounding code quoted, not deferred decisions.

**Type consistency:** `Job`'s six fields are declared in Task 1 and used with those names in Tasks 2–4. `reviveJobs(raw) -> { jobs, nextSeq }` and `listJobs() -> Job[]` are defined in Task 1 and called with those signatures in Tasks 1–2. `agentJobs(dir) -> { ok, jobs }` is defined in Task 3 and consumed in Task 4. `renderJobs(): string` keeps its existing signature, so `cli.ts:1859` needs no change.

## Known rough edges

- `refreshJobs` compares with `JSON.stringify` to decide whether to repaint. Fine for a list capped at 50 that changes every few seconds; it would not be for a hot path.
- Jobs are read from the serve for `agentCwd` only. A second project open in another window has its own serve and its own store — correct, but it means the panel shows this folder's jobs, not every job on the machine.
