---
name: accessibility
description: Audit and fix a11y issues — semantics, ARIA, contrast, keyboard nav, focus, and labels
category: frontend
---

# Accessibility

Use when a component or page needs an a11y pass: failing audits, keyboard traps, missing labels, or low contrast.

1. Start with semantics: replace `div`/`span` clickables with `button`, `a`, `nav`, `main`, `ul`, headings in order — native elements give you roles and keyboard support for free.
2. Label every interactive and form control: visible `<label htmlFor>`, or `aria-label`/`aria-labelledby`; give icon-only buttons an accessible name and decorative images `alt=""`.
3. Verify keyboard flow: Tab order is logical, every action is reachable and operable via Enter/Space, focus is visible, and modals trap focus and restore it on close.
4. Add ARIA only to fill gaps native HTML can't (`aria-expanded`, `aria-current`, `role="alert"`, `aria-live` for dynamic updates) — and remove redundant or wrong ARIA.
5. Check color contrast against WCAG AA (4.5:1 text, 3:1 large text / UI), and ensure state isn't conveyed by color alone (add icon/text).
6. Re-run an automated checker (axe/Lighthouse) plus a manual keyboard + screen-reader sweep, and fix what tooling flags.

## Rules
- Prefer native semantic HTML over ARIA; a wrong `role` is worse than none.
- Never remove focus outlines without providing an equally visible replacement.
- Every form input needs a programmatically associated label, not just placeholder text.
- Don't rely on color alone to communicate errors, status, or required fields.
- Announce async changes (toasts, validation, loading) via `aria-live` so screen readers catch them.
