---
name: web-page
description: Design and build a self-contained HTML page — report, dashboard, comparison, one-pager — that looks considered and works offline as a single file.
category: html
---

# Web Page

Use with `create_page` whenever the answer is better read than printed: a benchmark write-up, a
dashboard, a comparison, a proposal, anything the user will keep or send to someone.

## 1. Decide the treatment before writing any CSS

Most pages are **documents**: real typographic hierarchy, considered spacing, a proper palette, and
nothing else. A landing page or a tool earns an editorial treatment. Over-designing a memo is a
worse failure than under-designing one — a well-composed page is never wrong, a flashy one often is.

Name the subject, the reader, and the page's single job in one sentence. Everything below follows
from that sentence.

## 2. Sketch the tokens, then build from them

- **Colour** — 4–6 named values. Pick the neutral deliberately: a grey biased slightly toward the
  accent reads as chosen, a pure mid-grey reads as default. One accent, spent in one place.
  Semantic colours (good/warning/bad) are separate from the accent and don't count as it.
- **Type** — two roles minimum: something with character for headings, something quiet for reading.
  **System stacks only** (see below). Set a scale and stay on it.
- **Layout** — one sentence. Running text near 65–75 characters. Let flex/grid `gap` do the spacing
  rather than per-element margins that collapse and double.

If the project has its own tokens — a theme file, a CSS variables block, an existing page — use
those instead. The project's system beats your taste.

## 3. Non-negotiables

- **Self-contained.** No CDN scripts, stylesheets or webfonts; images as `data:` URIs. `create_page`
  rejects external scripts and stylesheets outright, because a page that needs the network isn't a
  file you can hand to someone. A webfont link that silently falls back is worse than a system stack
  chosen on purpose. In particular: **never link `fonts.googleapis.com`** - it is the single most common way a page stops working offline, and the failure is invisible to whoever wrote it.
- **Both themes.** Define the palette as custom properties on `:root`, redefine them under
  `@media (prefers-color-scheme: dark)`, and style components only through the tokens. Give the
  second theme the same care — don't invert and hope. A page that deliberately commits to one look
  may stay single-theme; make that a decision, not an oversight.
- **Wide content scrolls itself.** Tables, code and diagrams get their own `overflow-x: auto`
  container. The page body must never scroll sideways.
- **Digits line up.** `font-variant-numeric: tabular-nums` anywhere numbers sit in a column.
- **Floor.** Readable at 380px, visible keyboard focus, `prefers-reduced-motion` respected,
  every non-void element closed, every attribute quoted.

## 4. Structure has to mean something

Numbering, eyebrows, dividers and labels should encode something true — a real sequence, a real
grouping. `01 / 02 / 03` on three things that aren't ordered is decoration. Same for a big-number
hero: use it when one number _is_ the story, not as a default opening.

Write the copy as design material: plain verbs, active voice, specific over clever. Real content
throughout — never lorem, never invented figures.

## 5. Verify before claiming it's done

Open it (`create_page` does this) and actually look. Check the numbers on the page against their
source — a chart built by hand is the easiest place to ship a wrong bar. Check both themes and a
narrow window.

## Rules

- Don't reach for the current AI-design defaults unless the user asked: cream `#F4F1EA` with a serif
  and terracotta; near-black with one acid-green accent; purple-to-blue gradient hero; Inter for
  everything; emoji as section markers; everything centred.
- Charts drawn by hand: put every bar on a shared axis and label the absolute value. See the
  **chart** and **chart-svg** skills.
- Say where the file went. `create_page` prints the absolute path — don't paraphrase it away.
