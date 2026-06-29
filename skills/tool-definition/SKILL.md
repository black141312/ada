---
name: tool-definition
description: Define a new agent tool/function schema the LLM can call reliably
category: agent-llm
---

# Tool Definition

Use this when adding a callable tool/function to an agent so the model invokes it with correct arguments and at the right time.

1. Name the tool as a clear verb_noun (e.g. `search_orders`, `create_invoice`); the name is the model's primary cue for when to call it.
2. Write a description that states what it does, when to use it, and when NOT to use it — this matters more than the schema for routing accuracy.
3. Define a JSON-Schema for inputs: type every field, mark required vs optional, use enums for fixed choices, and add per-field descriptions.
4. Constrain inputs to reduce ambiguity — prefer enums over free text, give formats (date, uri) and examples in field descriptions.
5. Specify the return shape and keep it compact: return only what the model needs downstream, not raw dumps.
6. Test with adversarial prompts (ambiguous, missing args, wrong tool) and confirm the model selects correctly and fills required fields.

## Rules
- One tool = one job; if the description needs "and", split it into two tools.
- Make required fields truly required; optional-but-important fields get a description telling the model when to set them.
- Avoid overlapping tools with near-identical descriptions — the model will pick at random; disambiguate explicitly.
- Echo back enough context in the result for multi-step reasoning, but truncate large payloads (paginate or summarize).
- Never trust model-supplied arguments for security decisions; re-validate and authorize server-side.
