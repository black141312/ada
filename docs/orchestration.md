# Orchestration strategies

ada's harness splits into two roles so the *control flow* is pluggable:

- **Engine** — the harness primitives, in one place (`client/agent.ts`): `step()` (one model turn —
  stream, collect content + tool calls, recover leaked calls, push the assistant message),
  `runTools()`, `spawn()` (a headless sub-agent), plus `readDocs()` / `writeSkills()` /
  `soleIntegration()`. It owns streaming, tool-call recovery, compaction, approval, and sessions.
- **Orchestrator** — a Strategy that only decides *when* to call those primitives. An agent
  architecture is one small orchestrator; the engine never changes.

```ts
interface Engine { step(opts?): Promise<StepResult|null>; runTools(calls); spawn(prompt); … }
interface Orchestrator { name: string; run(e: Engine): Promise<void>; }
```

## Built-in strategies

| Strategy | Architecture |
|---|---|
| `react` (default) | reason → act → observe → repeat (the classic loop) |
| `single` | one model turn, no tools — quick Q&A |
| `plan` | a read-only plan first, then execute it |
| `multi` | decompose → fan out to sub-agents → synthesize |
| `toolsmith` | read the lone integration's docs → sub-agents author skills for it |

Select with `--strategy <name>` or the `/strategy [name]` command (default `react`).

## toolsmith — self-extending from an integration's docs

When **exactly one** connector is configured (`ada mcp add <name>`), `toolsmith`:

1. reads that integration's "docs" — the descriptions + schemas of its registered `<name>__*` tools;
2. a planning `step()` lists the capability **areas** (products, orders, payments, …);
3. fans out one **sub-agent per area** (`Engine.spawn`), each authoring a `SKILL.md` from the docs;
4. writes them to `.ada/skills/<name>-<area>/SKILL.md` under category `integration-<name>`.

```bash
ada mcp add epicmerch          # the only connector
ada --strategy toolsmith -p go # reads epicmerch's tools, writes epicmerch-* skills
```

The model then discovers them with `list_skills category=integration-epicmerch` and loads one with
`use_skill`. Adding a new agent architecture is one new `Orchestrator` in `agent.ts` — zero changes
to streaming, tools, or sessions. (Same discipline as the backend's *one adapter per wire format*.)
