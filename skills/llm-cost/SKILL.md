---
name: llm-cost
description: Estimate and reduce the token cost of LLM calls without losing output quality
category: agent-llm
---

# LLM Cost

Use this to measure where tokens go in an LLM workload and cut spend by trimming inputs, caching, and right-sizing the model.

1. Measure first: log input/output token counts per call (from the API response usage) and multiply by the model's per-token price to get real cost.
2. Find the hot path — usually a large system prompt or context re-sent on every turn, or oversized tool results echoed back.
3. Cache the stable prefix (system prompt, tool schemas, long shared context) with prompt caching so repeated tokens bill at the reduced rate.
4. Shrink inputs: trim/summarize history, paginate or filter tool outputs, drop redundant few-shot examples, and strip boilerplate.
5. Right-size the model: route easy/structured calls to a cheaper/smaller model and reserve the frontier model for hard reasoning.
6. Cap `max_tokens` to the real need and re-measure cost-per-task to confirm the change actually saved money.

## Rules
- Optimize by measured cost, not vibes — get token counts before and after every change.
- Output tokens usually cost several times more than input tokens; trimming verbose responses often beats trimming the prompt.
- Put cacheable content at the front and keep it byte-stable; any change to the prefix busts the cache.
- Summarizing history saves tokens but loses fidelity — keep recent turns verbatim and compress only older ones.
- A cheaper model that needs retries or longer outputs can cost more than the expensive one; compare end-to-end, not per-token.
