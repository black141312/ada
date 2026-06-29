---
name: few-shot
description: Build few-shot examples that steer an LLM toward the format and behavior you want
category: agent-llm
---

# Few-Shot Examples

Use this when zero-shot prompting gives inconsistent format or quality and you want to demonstrate the target behavior by example.

1. Pin down the exact target: the input shape, the output format, and the edge cases the model keeps getting wrong.
2. Write 3-5 examples as input/output pairs that match production data — same fields, same tone, same length you actually expect.
3. Cover variety deliberately: include a hard case, an edge case, and a "what not to do is implied" case, not five near-identical easy ones.
4. Make every example's output perfect and consistent in format — the model copies form as much as content, including mistakes.
5. Structure the prompt clearly: delimit examples (XML tags or labels) and separate them from the live input the model must answer.
6. Evaluate on a held-out set; add an example only when it fixes a real failure, and remove ones that don't move accuracy.

## Rules
- Consistency beats quantity — 3 flawless, format-aligned examples outperform 10 sloppy ones.
- Order can matter; put the most representative example last since recency biases the model.
- Don't let examples leak the test answer or encode spurious patterns (e.g. all positive labels first).
- More examples cost tokens on every call — prune to the minimum set that holds quality, then consider caching them.
- If the task is purely structural, prefer a schema/structured-output constraint over spending tokens on examples.
