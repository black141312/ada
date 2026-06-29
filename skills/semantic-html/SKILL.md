---
name: semantic-html
description: Audit and fix HTML for semantic structure and accessibility — landmarks, headings, ARIA, and keyboard support.
category: html
---

# Semantic HTML

Use when markup is a soup of `<div>`s, screen-reader output is broken, or an accessibility audit failed. The goal is meaning-bearing elements over generic containers.

1. Replace `<div>`-as-everything with landmarks: `<header> <nav> <main> <article> <section> <aside> <footer>`; exactly one `<main>` per page.
2. Fix the heading outline: a single `<h1>`, no skipped levels, headings chosen by document hierarchy not font size.
3. Swap fake interactive elements (`<div onclick>`) for real `<button>` / `<a>`; ensure everything actionable is keyboard-focusable and has a visible focus ring.
4. Add accessible names: `alt` on images (empty `alt=""` for decorative), `<label>` tied to every input, `aria-label` only where no visible text exists.
5. Use ARIA sparingly — prefer native semantics; only add roles/states the platform can't express, and never override correct native roles.
6. Validate: run an axe / Lighthouse / WAVE pass, tab through the page, and check with a screen reader (NVDA/VoiceOver) for sensible reading order.

## Rules
- Native element first, ARIA last; a `<button>` beats `role="button"` every time.
- No `alt`-less images, no unlabeled form controls, no positive `tabindex`.
- Don't use heading tags or lists for visual styling; style with CSS instead.
- Maintain logical DOM order so reading/tab order matches the visual layout.
- Every interactive control must be operable by keyboard and have a focus indicator (don't `outline:none` without a replacement).
