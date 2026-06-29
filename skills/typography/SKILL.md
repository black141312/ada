---
name: typography
description: Set an intentional modular type scale and font pairing with deliberate rhythm, measure, and hierarchy
category: ui-design
---

# Typography

Reach for this when text feels flat or noisy — everything the same weight, headings barely larger than body, lines too long to read. Typography carries most of a UI's perceived quality.

1. Pick a scale ratio and generate sizes from one base: 1.2 (minor third) for dense product UI, 1.25–1.333 for marketing. Use `clamp()` for fluid headings: `clamp(2rem, 1.2rem + 3vw, 3.5rem)`.
2. Pair at most two families with real contrast in role — e.g. a characterful display serif (Fraunces) over a neutral workhorse sans (Inter), or one superfamily across weights. More than two fonts reads as chaos.
3. Set body deliberately: 15–18px, `line-height` 1.5–1.65, and constrain measure to 60–75ch with `max-width: 65ch`. Long lines are the most common readability failure.
4. Build hierarchy with weight and size and color together — not size alone. A muted `--text-muted` for captions, a heavier 600–700 for headings, tight tracking (`-0.02em`) on large display text.
5. Tighten leading as size grows (headings 1.1–1.2, body 1.5) and add `text-wrap: balance` on headings, `pretty` on paragraphs to kill orphans.
6. Enable OpenType features that fit the context: `font-feature-settings` for tabular numerals in tables/dashboards, ligatures for prose; `font-variant-numeric: tabular-nums` stops number jitter.
7. Verify the rendered rhythm at real sizes and viewports, not in the abstract — print a paragraph plus h1–h4 and adjust.

## Rules
- Two type families maximum; if you need a third role, change weight, not font.
- Body measure 60–75ch; never let prose run the full container width.
- Pair every font-size with an intentional line-height — don't inherit a global 1.5 onto display text.
- Use tabular numerals anywhere numbers align in columns or update live.
- Establish scale steps as tokens; reaching for an off-scale `font-size: 19px` is a smell.
