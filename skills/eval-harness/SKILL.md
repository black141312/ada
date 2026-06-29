---
name: eval-harness
description: Build a reproducible evaluation harness for a model or agent
category: data-ml
---

# Eval Harness

Use when you need to measure how well a model, prompt, or agent performs against a fixed dataset, and compare versions over time without moving goalposts.

1. Define the task as inputs plus a scoring function; pick metrics that actually reflect the goal (accuracy, F1, pass@k, exact match, rubric score).
2. Build a versioned dataset of cases with expected outputs or grading criteria; keep a small dev set and a frozen test set.
3. Make each case independent and the runner deterministic where possible — fix seeds and temperature, record model/version.
4. Run cases in parallel with isolation, capturing the raw output, score, latency, and cost per case.
5. Aggregate into a scorecard (overall and per-category) and persist results keyed by model/prompt version for diffing.
6. Inspect failures by reading actual transcripts, not just the aggregate; add hard cases back into the dataset.

## Rules
- Freeze the eval set; changing cases and the system in the same run makes results uncomparable.
- Save raw outputs alongside scores so any regression can be inspected after the fact.
- For LLM-as-judge graders, validate the judge against human labels and pin the judge model/prompt.
- Report cost and latency next to quality — a better score that's 10x slower is a real tradeoff.
- Always look at concrete failing cases; aggregate metrics hide systematic errors.
