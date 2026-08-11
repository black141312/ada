# Background jobs you can actually read

**Date:** 2026-08-11
**Scope:** `cos0` (the `ada-agent` engine) and `ada-app` (the desktop app). No backend changes.

## The problem

`background_task` works, and its result is unreachable from the Ada app.

The tool starts a sub-agent, returns a job id, and tells the model:

> `Started background job j1. Check results with /jobs (don't wait on it).`

`/jobs` is a REPL command in the terminal CLI ([src/client/cli.ts:1859](../../../src/client/cli.ts)). It is not
exposed over the serve HTTP API, and the app has no UI for it. So in the app a background job
runs, finishes, and its result sits in a `Map` that nothing can ever read. The tool's own success
message points at a command the user does not have.

Jobs are also in-memory only, so they die with the `ada serve` process — acknowledged in the file's
own `ponytail:` comment ([src/client/background.ts:2](../../../src/client/background.ts)).

## What already works, and is not in scope

Sub-agents inside a single chat are built and shipped:

- `spawn_agent` — delegate a subtask, wait, return its summary.
- `background_task` — fire and forget.
- **Parallel fan-out.** Both are registered with `needsApproval: false`, which puts them in the
  concurrent batch in `execTools` ([src/client/agent.ts:1193](../../../src/client/agent.ts)) — several
  sub-agents in one turn already run at once.
- A separate, cheaper model for sub-agents (`settings.subagentModel` / `ADA_SUBAGENT_MODEL`).
- Per-sub-agent token and cost accounting.
- All of it registered on the `ada serve` path ([src/client/cli.ts:1081](../../../src/client/cli.ts)), so
  the app gets the same tools the REPL does.

None of that changes. This spec only makes the results reachable.

## Design

### Where jobs live

`.ada/jobs.json`, per project. `ada serve` already runs per folder, so jobs are scoped that way
without inventing anything.

`ensureAdaDir` ([src/client/settings.ts:149](../../../src/client/settings.ts)) writes a `.gitignore` inside
`.ada/` listing the machine-generated caches, deliberately not a blanket `*` because `memory/` and
`skills/` are meant to be committed. `jobs.json` is a machine-generated cache and joins that list —
otherwise Ada starts dirtying the `git status` of every repo it is opened in, which is the exact
problem that helper exists to prevent.

### Engine: `src/client/background.ts`

The `jobs` Map gains a disk backing. Four things follow from that, and three of them are not
optional.

**A job still marked `running` at load time becomes an error.** The process that owned it is gone,
so it will never transition. Loading it as-is would show a job running forever — a worse bug than
the one being fixed, and permanent rather than transient. On load, any `running` job is rewritten
to `status: "error"` with `result: "interrupted — ada serve restarted"`.

**The id counter must be seeded from what was loaded.** Ids are `j${++seq}` with `seq` starting at
0 in module scope. After a restart it would hand out `j1` again and silently overwrite the
persisted `j1`. On load, `seq` is set to the highest numeric suffix present.

**Writes happen on every status transition**, not on a timer — three writes per job over its whole
life, of a file capped at 50 entries. Whole-file `writeFileSync`; no partial-update machinery for
something this small.

**Failure to read or write is never fatal.** A read-only checkout, a corrupt file, a permissions
problem — jobs fall back to in-memory exactly as they behave today. Wrapped in try/catch, same as
`ensureAdaDir`'s own write.

The record gains `ended?: number` so a finished job can show when it finished.

Cap at 50, newest first, pruned on save.

New export:

```ts
export function listJobs(): Job[]
```

`renderJobs()` stays, reimplemented as a formatter over `listJobs()`, so the CLI's `/jobs` output is
unchanged and there is one source of truth.

### Engine: `src/client/cli.ts`

One route, beside the existing `/v1/sessions` and `/v1/skills`:

```
GET /v1/jobs → { jobs: Job[] }
```

Read-only, no parameters. Serves `listJobs()`.

### App: `ada-app`

**`electron/main.js` + `electron/preload.js`** — an `agentJobs(dir)` IPC that GETs `/v1/jobs` from
the serve for that folder, following the shape of the existing serve calls. Returns `{ ok, jobs }`
or `{ ok: false, error }`; a serve that is not running is not an error worth surfacing, just an
empty list.

**`src/app.js`** — a **Background jobs** section in the tasks panel that already exists
([src/app.js:748](../../../../ada-app/src/app.js) and the `tp-row` rows below it), rendered below the
running and finished sections.

Unscoped, and deliberately so: `registerSubagentTools` is called once at serve startup with no
session context ([src/client/cli.ts:1081](../../../src/client/cli.ts)), so a `Job` has no idea which
chat spawned it. Attributing jobs per-chat would mean threading a session id through the tool
registry — real surgery on the engine's tool registration for a labelling improvement. The section
is headed so the difference from the per-chat rows above it is visible rather than confusing.

Fetched when the panel opens, polled every 3s while it stays open, stopped when it closes. No new
streaming plumbing, and nothing polls while the panel is shut.

A finished row expands to show its `result`. That text is the entire point of the change — it is
what is currently unreachable.

### Error handling

The engine's job runner already captures both outcomes into `status`/`result`
([src/client/background.ts:30-38](../../../src/client/background.ts)); nothing changes there. The new
failure modes are all I/O and all degrade to today's behaviour:

| Failure | Behaviour |
| --- | --- |
| `.ada/jobs.json` unreadable or corrupt | Start empty, in-memory only. Log once, do not throw. |
| `.ada/` not writable | Jobs work in memory, exactly as today. |
| Serve not running when the app polls | Empty list, no error shown — the panel simply has no jobs section. |
| Job was `running` when the process died | Loads as `error: "interrupted — ada serve restarted"`. |

### Testing

`selfcheck.ts` already covers the happy path ([src/selfcheck.ts:827](../../../src/selfcheck.ts)). Three
additions, all on the pure part:

- **Round-trip.** Save jobs, reload, get the same records back.
- **Stale running.** A file containing a `running` job loads it as `error`, with the interrupted
  message — not as running.
- **Id continuation.** After loading a file whose highest job is `j7`, the next `startJob` returns
  `j8`, not `j1`, and does not overwrite the existing record.

These run under `npm run selfcheck` (`tsx src/selfcheck.ts`), which is where the existing job test
lives. Note this repo has no `npm test` — `selfcheck` and `typecheck` are the sensors.

The app side is DOM wiring with no test harness in that repo; it is verified in the browser preview
(`npx vite --port 5173`), the same way the concurrent-chats work was.

## Out of scope

- Per-chat attribution of jobs.
- Cancelling a running job.
- Any notification when a job finishes — the tasks chip already carries counts.
- Changes to `spawn_agent`, to fan-out, or to the sub-agent model setting. Those work.

## Two repos

The engine change stands alone and is useful on its own: it fixes `/jobs` surviving a restart, and
adds the endpoint. The app change depends on the endpoint existing. Land the engine side first.
