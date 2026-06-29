---
name: prompt-template
description: Design and refine a structured, testable LLM prompt template
category: data-ml
---

# Prompt Template

Use when building a reusable prompt for a production task (extraction, classification, generation) where output structure and reliability matter.

1. Write a clear role and task statement, then specify the exact output format (JSON schema, fields, or enum) the caller will parse.
2. Separate static instructions from dynamic inputs with explicit delimiters or template variables so user content can't override instructions.
3. Add 2-3 few-shot examples covering the tricky and edge cases, including how to handle missing or ambiguous input.
4. State failure behavior explicitly: what to output when the answer is unknown, input is empty, or it can't comply.
5. Test on a labeled set of inputs, read the failures, and iterate the wording — change one thing at a time.
6. Version the template and pin the model; treat prompt edits like code changes with before/after eval scores.

## Rules
- Specify output format precisely and validate/parse it on the way out; don't trust prose to be machine-readable.
- Keep instructions and untrusted input clearly separated to reduce prompt injection.
- Few-shot examples should target real failure modes, not just happy-path repetition.
- Change one variable per iteration and measure on a fixed set — vibes don't catch regressions.
- Pin the model and version the prompt; the same template can behave differently across models.
