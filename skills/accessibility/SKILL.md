---
name: accessibility
description: Audit and fix a11y and semantic-HTML issues — landmarks, heading outline, ARIA, contrast, keyboard nav, focus, and labels
category: frontend
---

# Accessibility

Use when a component or page needs an a11y pass: failing audits, keyboard traps, missing labels, or low contrast.

1. Start with semantics: replace `<div>`-as-everything with real landmarks — `<header> <nav> <main> <article> <section> <aside> <footer>`, exactly one `<main>` per page — and swap `<div onclick>` for `<button>`/`<a>`. Native elements give you roles and keyboard support for free.
2. Fix the heading outline: a single `<h1>`, no skipped levels, headings chosen by document hierarchy rather than font size.
3. Label every interactive and form control: visible `<label htmlFor>`, or `aria-label`/`aria-labelledby`; give icon-only buttons an accessible name and decorative images `alt=""`.
4. Verify keyboard flow: Tab order is logical, every action is reachable and operable via Enter/Space, focus is visible, and modals trap focus and restore it on close.
5. Add ARIA only to fill gaps native HTML can't (`aria-expanded`, `aria-current`, `role="alert"`, `aria-live` for dynamic updates) — and remove redundant or wrong ARIA.
6. Check color contrast against WCAG AA (4.5:1 text, 3:1 large text / UI), and ensure state isn't conveyed by color alone (add icon/text).
7. Re-run an automated checker (axe/Lighthouse) plus a manual keyboard + screen-reader sweep, and fix what tooling flags.

## Rules
- Prefer native semantic HTML over ARIA; a wrong `role` is worse than none.
- Never remove focus outlines without providing an equally visible replacement.
- Every form input needs a programmatically associated label, not just placeholder text.
- Don't rely on color alone to communicate errors, status, or required fields.
- Announce async changes (toasts, validation, loading) via `aria-live` so screen readers catch them.
- No positive `tabindex`, and keep DOM order matching the visual layout so reading and tab order agree.
- Don't use heading tags or lists for visual styling — style with CSS instead.
- Verify with a real screen reader (NVDA/VoiceOver) for sensible reading order, not just an automated checker.
