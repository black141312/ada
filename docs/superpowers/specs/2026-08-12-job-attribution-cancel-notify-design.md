# Jobs that know whose they are, can be stopped, and say when they finish

**Date:** 2026-08-12
**Scope:** `cos0` (the `ada-agent` engine) and `ada-app` (the desktop app). No backend changes.
**Builds on:** [2026-08-11-background-jobs-reachable-design.md](2026-08-11-background-jobs-reachable-design.md), which made a job's result readable at all.

## The three gaps

The previous spec ruled all three of these out of scope. Two were genuine scope calls; one was
justified by a claim that turned out to be false.

**A job has no idea which chat spawned it.** The Background jobs section is therefore unscoped,
sitting under a panel whose other sections filter per chat. It reads as a broken filter.

**A running job cannot be stopped.** Start a twenty-minute sub-agent by accident and it runs to
completion, spending tokens the whole way.

**A finished job is invisible until you go looking.** The previous spec dismissed notifications
because "the tasks chip already carries counts". It does not. `renderChatTasksChip` counts
`bgTasks.running` filtered by `sessId === current?.id`; jobs live in a separate `jobsCache` and have
no session, so **the chip has never counted them**. A job can start, run, and finish with no
indication anywhere unless the panel happens to be open.

## Why these are one spec, in this order

They share a data shape. Attribution adds `sessionId` to the `Job` record; cancel adds a live handle
beside it and a fourth `status`; the notification reads both to decide what to show and whose chat
to show it in. Building attribution last means building the other two twice.

Order: **attribution → cancel → notification.**

## Part 1 — Attribution

### The tool contract gains a context argument

`Tool.run` is context-free today:

```ts
run(args: Record<string, unknown>): Promise<ToolResult>
```

It becomes:

```ts
run(args: Record<string, unknown>, ctx?: ToolCtx): Promise<ToolResult>
```

```ts
/** What the calling agent knows about itself. Optional because most tools neither need nor read it,
 *  and because an agent outside a serve session genuinely has no id to give. */
export interface ToolCtx {
  sessionId?: string;
}
```

Every existing tool ignores the new parameter — no call site changes.

### One chokepoint supplies it

Every tool invocation in the engine funnels through `safeRun` ([src/client/agent.ts:608](../../../src/client/agent.ts)):

```ts
async function safeRun(tool: Tool, args: Record<string, unknown>): Promise<ToolResult>
```

It gains a `ctx` parameter and passes it to `tool.run`. The `Agent` supplies
`{ sessionId: this.sessionId }` from a new optional construction option.

**Why an argument and not an ambient "current session".** The obvious alternative — a module-level
`currentSessionId` the tool reads at call time — is wrong now. Several chats stream concurrently as
of the concurrent-chats work, so an ambient value is whichever turn most recently set it, not the
one asking. That is precisely the single-slot-global pattern that work spent its length removing.
Passing the id down the call stack is correct by construction, and costs one parameter.

### The serve tells its Agent who it is

`makeSession` in [src/client/cli.ts:1090](../../../src/client/cli.ts) builds the `Agent` and then
generates `const id = newId("sess")`. Move the id generation above the `new Agent({ … })` call and
pass it in. Nothing else about that function changes.

The REPL and one-shot CLI paths leave `sessionId` undefined, and that is correct rather than a gap:
a job started from a terminal belongs to no chat.

### The job records it

`Job` gains `sessionId?: string`. `startJob(task, run)` gains a third parameter, and
`background_task`'s `run` passes `ctx?.sessionId` through.

`reviveJobs` carries the field across a restart like any other.

### The app scopes the section

A chat already stores the engine's session id as `sess.adaSessionId`. A job belongs to the chat
where `job.sessionId === sess.adaSessionId`.

When the panel is chat-filtered (`tasksFilterSess` set), the jobs section shows only that chat's
jobs. In the unscoped view it shows everything, including jobs with no `sessionId` — those are
terminal-started and belong to no chat, so they appear only there, under the existing heading.

The section heading stays "Background jobs" — it is still a different kind of row from the per-chat
tasks above it, and the difference is now scope-consistent rather than scope-absent.

## Part 2 — Cancel

### A live handle, never persisted

`AgentSession` already carries `ctrl: AbortController | null`, "set while a turn runs — doubles as
the busy flag" ([src/client/cli.ts:1078](../../../src/client/cli.ts)). Jobs follow that precedent.

`startJob` creates an `AbortController` and holds it in a module-level `Map<string, AbortController>`
keyed by job id — **not** on the `Job` record, because `Job` is serialised to `.ada/jobs.json` and a
controller means nothing after a restart. The map is pruned when a job settles.

`SendCtrl` already accepts `signal?: AbortSignal` ([src/client/agent.ts:62](../../../src/client/agent.ts)),
and `background_task` already passes a `SendCtrl` (`{ quiet: true, delegated: true }`). Cancelling is
therefore adding one field to an object that already exists.

### A fourth status

`Job["status"]` becomes `"running" | "done" | "error" | "cancelled"`.

Folding a cancellation into `"error"` would make a deliberate stop indistinguishable from a crash,
in the one list a user consults to find out what happened. `reviveJobs` must learn the new value
regardless — its coercion currently sends anything unrecognised to `"done"`
([src/client/background.ts:64](../../../src/client/background.ts)), which would silently relabel a
cancelled job as successful across a restart.

A cancelled job keeps whatever partial text it produced, or `"cancelled"` if none.

### The route and the button

`POST /v1/jobs/:id/cancel` — aborts if the job is running, returns the job's new state. Cancelling an
already-settled job is a no-op success, not an error: the user clicked a button that raced the job
finishing, and that is not a failure worth reporting.

App: `agentJobCancel(dir, id)` IPC, and a cancel control on running rows only. It calls
`e.stopPropagation()` for the same reason the expand handler does — the row rebuilds itself, and
without it the document-level handler closes the panel.

## Part 3 — Notification

Jobs join the chip that already exists, which is what the previous spec wrongly assumed was already
true.

`renderChatTasksChip` counts this chat's running `bgTasks`. It also counts this chat's running jobs —
now possible, because jobs have a `sessionId`.

For "finished while you were not looking", one timestamp: `jobsSeenAt`, set when the panel opens.
A job is unseen when `ended > jobsSeenAt`. The chip reports unseen finishes for this chat, and
opening the panel clears them by advancing the timestamp.

That is the whole mechanism. No toast, no OS notification, no persistence of seen-state across an
app restart — a restart showing you a finished job again is the harmless direction to fail.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Tool called by an agent with no `sessionId` | `ctx.sessionId` is `undefined`; the job is unattributed and shows only in the unscoped view. |
| Cancel for an unknown job id | 404. The app treats it as already-gone and refreshes. |
| Cancel for a settled job | 200, no-op. Racing the finish is not an error. |
| Abort rejects inside the sub-agent | Caught by `startJob`'s existing rejection path; status is set to `"cancelled"` rather than `"error"` when the controller was the cause. |
| A `"cancelled"` job read by an older app build | Renders as `background job · cancelled` — the app formats the status string rather than switching on it. |

## Testing

Engine, in `selfcheck.ts` (this repo has no `npm test`):

- A job started with a `sessionId` records it, and `reviveJobs` round-trips it.
- A cancelled job settles as `"cancelled"`, not `"error"`.
- `reviveJobs` preserves `"cancelled"` rather than coercing it to `"done"`.
- A job with no `sessionId` is still valid and still listed.

App: browser-preview verification with `window.ada.agentJobs` mocked, as before — scoping, the
cancel control, and the chip's unseen count.

## Out of scope

- Changes to `spawn_agent`, to fan-out, or to `subagentModel`. Those work.
- Cancelling a job owned by a different `ada serve` process.
- Any cross-project view of jobs.
- Persisting seen-state across an app restart.
- OS-level or toast notifications.

## Two repos

Engine first, as before: the app's scoping, cancel button and chip all read fields the engine has to
produce. Within the engine, attribution before cancel — the fourth status and the controller map
both sit in code attribution has already touched.
