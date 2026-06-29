---
name: form-validation
description: Add client-side and server-side form validation with a shared schema and clear error UX
category: frontend
---

# Form Validation

Use when a form accepts user input that must be validated — required fields, formats, ranges — on both the client and the server.

1. Define one validation schema (e.g. Zod/Yup/Valibot) as the source of truth for field rules, and share it between client and server so they can't drift.
2. Validate on the client for fast feedback: validate a field on blur/change and the whole form on submit; disable submit while invalid or in-flight.
3. Show errors inline next to each field, tie them to the input via `aria-describedby`/`aria-invalid`, and move focus to the first error on failed submit.
4. Re-validate on the server with the same schema — treat client validation as UX only and never trust the incoming payload.
5. Return structured field-level errors from the server and map them back onto the matching inputs, plus a form-level message for non-field failures.
6. Cover edge cases: trimming/normalizing input, duplicate submits, async checks (e.g. unique email), and preserving entered values after a failed submit.

## Rules
- Server validation is mandatory; client validation can be bypassed and is for UX only.
- Keep one schema as the single source of truth — don't duplicate rules in two places.
- Associate every error message with its input via ARIA so it's announced and reachable.
- Validate format AND business rules (uniqueness, allowed values), not just "non-empty".
- Don't block typing or wipe the user's input on error; show the problem and let them fix it.
