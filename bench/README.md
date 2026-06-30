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
