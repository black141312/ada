---
name: html-form
description: Build an accessible form with native + custom validation, clear error messaging, and correct input semantics.
category: html
---

# HTML Form

Use for any data-entry UI (signup, checkout, settings). Lean on native HTML form features first; add JS only to enhance, not replace, them.

1. Structure with a real `<form>`, every control wrapped by or linked to a `<label for>`; group related fields in `<fieldset>` with a `<legend>`.
2. Use the right input types and attributes (`type=email/tel/number/date`, `inputmode`, `autocomplete`, `required`, `minlength`, `pattern`) so browsers validate and mobile keyboards adapt.
3. Validate progressively: native constraints first, then JS via the Constraint Validation API (`setCustomValidity`, `:invalid`); validate on blur/submit, not on every keystroke.
4. Surface errors accessibly: tie each message to its field with `aria-describedby`, set `aria-invalid="true"`, move focus to the first error, and announce a summary in a live region.
5. Submit safely: prevent double-submit, show a pending state, handle server errors, and re-validate on the server (client validation is never trusted).
6. Polish UX: logical tab order, visible focus states, helpful placeholder vs. label distinction, and preserve entered values on failed submit.

## Rules
- Every input needs a programmatically associated `<label>`; placeholders are not labels.
- Use native validation attributes before reaching for JS; they work without scripts.
- Errors must be perceivable by screen readers (`aria-describedby` + `aria-invalid`), not color alone.
- Always re-validate and sanitize on the server — client checks are a UX nicety, not security.
- Set `autocomplete` and correct `type`/`inputmode` so password managers and mobile keyboards work.
