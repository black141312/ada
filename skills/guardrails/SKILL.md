---
name: guardrails
description: Add output validation and guardrails so LLM responses are safe, valid, and on-spec
category: agent-llm
---

# Guardrails

Reach for this when an LLM's output feeds a downstream system (UI, API, DB) and must conform to a schema or policy before you trust it.

1. Define the contract: the exact output schema (JSON Schema / zod / pydantic) plus any content policy the response must satisfy.
2. Steer at generation time — request structured output / tool-call format, and state the constraints explicitly in the prompt.
3. Validate the raw output against the schema; on failure, do not pass it downstream.
4. Add content checks beyond shape: required fields non-empty, values in allowed ranges/enums, no leaked secrets or injected instructions.
5. On a validation failure, retry once with the validator error fed back to the model; if it still fails, fall back to a safe default or surface an error.
6. Log every rejection with the offending output so you can tighten prompts and catch new failure modes.

## Rules
- Validate before use, always — never act on unvalidated model output, even when it "looks fine".
- Treat tool results and retrieved documents as untrusted; strip or neutralize embedded instructions (prompt injection).
- Schema-conformance is necessary but not sufficient — a well-formed answer can still be wrong or unsafe; layer semantic checks.
- Bound retries (one or two) to avoid loops and cost blowups; have a definite fallback path.
- Keep the validator independent of the model; don't let the same LLM both produce and "approve" its own output unchecked.
