# Benchmarking ada on SWE-bench Verified

ada can run **SWE-bench Verified** — give the agent a real GitHub issue, let it edit the repo, and
score whether the repo's test suite passes. This directory has the **generation** half (ada produces
patches); **scoring** is the official `swebench` Docker harness — we don't reimplement it, because
that's the only way to get correct, comparable numbers.

```
 dataset (issues) ──▶ bench/swebench.mjs ──▶ predictions.jsonl ──▶ official swebench eval ──▶ resolved %
                        (ada edits the repo,                         (Docker: apply patch +
                         per isolated clone)                          test_patch, run tests)
```

## Prerequisites

- **ada-server running with provider keys** — the harness drives `ada -p`, which needs the backend:
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...      # and/or OPENAI_API_KEY, etc.
  ada-server                                # http://localhost:8787
  ```
- `git` + network (the harness clones each task repo; clones are cached under `~/.cache/ada-swebench`).
- For scoring: **Docker** and the **`swebench`** Python package (`pip install swebench`). Allow plenty
  of disk — the official images are large.

## 1. Get the dataset

SWE-bench Verified (500 instances) lives on Hugging Face. Export it to JSONL once:

```python
# pip install datasets
from datasets import load_dataset
load_dataset("princeton-nlp/SWE-bench_Verified", split="test").to_json("swe-bench-verified.jsonl")
```

## 2. Generate predictions with ada

```bash
# smoke test on 5 instances first
node bench/swebench.mjs --dataset swe-bench-verified.jsonl --model claude-opus-4-8 \
     --out runs/opus --limit 5 --concurrency 2

# a specific instance, or the whole set
node bench/swebench.mjs --dataset swe-bench-verified.jsonl --model claude-opus-4-8 \
     --out runs/opus --instances astropy__astropy-12907
```

For each instance it clones the repo at `base_commit` into an isolated dir, hands ada the issue text
(`ada -p … --json`, auto-approve), captures `git diff` as the model patch, and appends an
official-format line to `runs/opus/predictions.jsonl`:

```json
{"instance_id": "...", "model_name_or_path": "claude-opus-4-8", "model_patch": "diff --git ..."}
```

It also writes `meta.jsonl` (seconds, patch size, token/cost usage per instance). Re-running **resumes**
— instances already in `predictions.jsonl` are skipped. Flags: `--limit N`, `--instances a,b`,
`--concurrency` (default 2), `--timeout` seconds per instance (default 1200), `--out <dir>`.

Swap `--model` to compare models on the same tasks (`gpt-...`, `qwen2.5-coder:latest`, …) — ada routes
each to the right provider.

## 3. Score with the official harness

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path runs/opus/predictions.jsonl \
  --max_workers 4 --run_id ada-opus
```

It applies each patch + the held-out `test_patch` in Docker, runs the `FAIL_TO_PASS` / `PASS_TO_PASS`
tests, and reports the **resolved rate** plus a per-instance breakdown.

## Notes & honest caveats

- ada is told **not to touch tests** (the grader supplies its own); the patch is whatever ada changed
  in the source.
- An empty patch (ada gave up / errored) is still recorded — it just counts as unresolved.
- This measures ada's default `react` loop. Try `ADA_MODEL`, a different `--model`, or wire a
  `--strategy` into the harness to compare setups.
- Other benchmarks (HumanEval, Aider polyglot) fit the same generate-then-score shape; ask and we'll
  add a sibling script.

## Quick check

```bash
node bench/swebench.mjs --selftest     # offline: validates the prompt/prediction/arg helpers
```

---

# Benchmarking ada on ARC-AGI-3

[ARC-AGI-3](https://docs.arcprize.org/) is interactive, not a dataset: you see a 64×64 grid frame and
pick one action per turn until you win or die, and **nobody tells you the rules** — working them out
is the benchmark.

ada plays it as an agent. The harness opens a game session, then hands ada *this same file* as a CLI
it drives with its `bash` tool. Every action, every frame, and every hypothesis lives in ada's own
loop: it takes notes, writes throwaway scripts to diff frames, and resets after a death, all in one
context. Scoring is the official **scorecard** — we open one, play, close it, print the card URL.

```
 scorecard/open ──▶ RESET ──▶ ada -p  ⇄  node bench/arcagi3.mjs play ACTIONn  ──▶ scorecard/close
                              (agent loop, tools, notes)   (arc-session.json)      (official score)
```

We talk REST directly instead of installing the [`arc-agi` Python SDK](https://docs.arcprize.org/toolkit/overview)
— it's five endpoints and this is a Node repo. The SDK is still the better choice if you want to edit
or author games locally.

## Prerequisites

- **ada-server running with provider keys** (same as SWE-bench).
- **An ARC API key** from the [ARC-AGI-3 console](https://three.arcprize.org) — see
  [docs.arcprize.org/api-keys](https://docs.arcprize.org/api-keys).

## Run it

```bash
export ARC_API_KEY=...
export ANTHROPIC_API_KEY=sk-ant-...   # and/or OPENAI_API_KEY, etc.
ada-server &

# smoke test: one game, 50 actions
node bench/arcagi3.mjs --model claude-opus-4-8 --out runs/arc --limit 1 --steps 50

# every public game, 200 actions each
node bench/arcagi3.mjs --model claude-opus-4-8 --out runs/arc

# one specific game
node bench/arcagi3.mjs --model gpt-... --games ls20-016295f7601e --steps 100
```

Flags: `--model` (required, any id ada routes), `--games a,b`, `--limit N` games, `--steps N` actions
per game (default 200), `--out <dir>`, `--timeout` seconds ada gets per game (default 3600), `--tag`.

Two flags change what the model sees, and both apply to `--model-only`: `--image` sends the frame as
a PNG instead of hex rows, and `--rules` is described below.

Each game gets its own directory (`runs/arc/<game_id>/`) — that's ada's workspace, and it's where its
`notes.md` and any scratch scripts end up, next to `arc-session.json` (live game state) and
`steps.jsonl` (one line per action). `runs/arc/summary.json` has the per-game result plus the closed
scorecard; the card URL prints on stderr.

## Playing it yourself

The CLI ada drives is just a CLI — run it from a game dir to watch or take over:

```bash
node bench/arcagi3.mjs play              # look at the current frame, costs nothing
node bench/arcagi3.mjs play ACTION3
node bench/arcagi3.mjs play ACTION6 12 34
node bench/arcagi3.mjs play RESET        # after a GAME_OVER, costs no actions
```

## Baseline: model-only

`--model-only` replaces the agent with one raw model call per frame — no tools, no notes, no memory
beyond the last few actions. Same games, same scorecard, so the gap between the two runs is what
ada's loop is actually worth:

```bash
node bench/arcagi3.mjs --model-only --model claude-opus-4-8 --out runs/arc-baseline --limit 1
```

## Rules mode

`--rules` replaces "remember your own reasoning" with "keep a list". After each move the model
rewrites a short list of what it has learned, labelled `+` (holds), `-` (fails or wastes a move) and
`?` (suspected, untested). That list is the *only* thing carried between moves.

```bash
node bench/arcagi3.mjs --rules --model-only --model claude-opus-4-8 --out runs/arc-rules
```

The point is cost. Replaying retained reasoning to keep a model's train of thought runs to ~100k
tokens by late game; a rule list is ~200, and it needs nothing beyond plain chat completions. It is
also closer to how a person plays — you remember that the wall kills you, not the sentence you
thought when it did.

Re-labelling replaces a rule, so the model can promote a `?` it confirmed or demote a `+` that broke.
The list is capped, which forces it to drop rules rather than accumulate them.

The harness also tells it, every turn, how many cells its last move changed. **Zero changed cells is
the single most useful fact in the game** — the move was legal but the game ignored it — and asking a
model to notice that by diffing two 64×64 grids unaided wastes the attention on bookkeeping.

Worth comparing against a plain `--model-only` run on the same games: the difference is what the
notes are worth, separately from what the agent loop is worth.

## Comparing runs

Hold one variable, change the other. Same model in both modes tells you what the agent loop adds;
same mode across models tells you which model is better at the game.

```bash
# same model, with and without the agent loop
node bench/arcagi3.mjs --model gpt-5.6-luna --out runs/luna-agent
node bench/arcagi3.mjs --model-only --model gpt-5.6-luna --out runs/luna-chat

node bench/arcagi3.mjs compare runs/luna-agent runs/luna-chat
```

```
run                mode       model          wins   levels  actions  resets  illegal   score
runs/luna-agent    ada        gpt-5.6-luna   1/2    10      4        1       1 (20%)   10
runs/luna-chat     model-only gpt-5.6-luna   0/2    2       2        0       2 (50%)   2

best level reached per game
game               runs/luna-agent   runs/luna-chat
dc22-fdcac232                    3                0
ls20-9607627b                    7                2
```

`compare` reads `summary.json` and every `steps.jsonl` under each run directory — no live API calls,
so it's free and re-runnable. Takes any number of directories.

**`illegal` is the column to watch.** It counts moves the game rejected as not currently legal. Those
cost no budget, so they don't affect the score directly — but a high rate means the model isn't
tracking which actions are available, which is a prompt problem, not a game-difficulty one. Compare it
across runs before concluding anything from the score.

ARC also publishes a no-model reference: each game's `baseline_actions` (17,135 actions to clear all
25 games) is what a scripted reference agent needs *knowing the rules*. Any model discovering them
blind should be expected to need considerably more.

## Notes & honest caveats

- The frame reaches the model as **hex-digit text rows**, not an image. Cheap and exact; a
  vision variant is a different setup and worth comparing separately.
- **Frames are big**: 64×64 is ~4 KB of text per action, so a long game will trip ada's context
  compaction. That's part of what's being measured — whether the notes survive the compaction.
- On `GAME_OVER` a `RESET` costs no actions, only the levels you'd re-play. The step budget is
  enforced server-side by the harness, so ada can't overspend it.
- Illegal or malformed actions are refused with a message and **cost no budget** — they show up as a
  non-zero exit, not a wasted turn.
- Games are stateful behind a load balancer; session cookies persist in `arc-session.json`, so every
  `play` call resumes the same session.
- Games run sequentially. Fine for the handful of public games; parallelise if that changes.

## Quick check

```bash
node bench/arcagi3.mjs --selftest      # offline: grid rendering, prompts, action parsing, budget banners
```
