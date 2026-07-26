---
name: ui-ux-pro-max
description: UI/UX design intelligence - searchable corpus of 84 visual styles, 192 colour palettes, 74 font pairings, 192 product types, 98 UX and accessibility rules, motion presets, chart guidance and per-stack conventions across 22 stacks. Use when designing, building, styling or reviewing any interface.
category: ui-design
---

# UI/UX Pro Max

A queryable corpus of design decisions, not more advice about design. Ask it what to build and it
returns real values: hex codes, spring constants, font pairings with their CSS import, WCAG grades,
framework compatibility scores, and an implementation checklist.

Query it with the **`ui_ux_search`** tool. No Python, no scripts, no setup — the corpus ships inside
ada and the search runs in-process.

## Use it twice

**Before writing UI** — decide, don't improvise:

1. `ui_ux_search("<product type> <audience> <mood>")` → a visual style with concrete values.
2. `ui_ux_search("colour palette for <product type>", domain: "color")` → semantic tokens.
3. `ui_ux_search("font pairing for <mood>", domain: "typography")` → heading/body pair + import.
4. `ui_ux_search("<framework> conventions", stack: "react")` → how that stack expects it done.

**After writing UI** — review against the rules that matter most, in this order:

| #   | Check               | Domain                | Must have                                                   |
| --- | ------------------- | --------------------- | ----------------------------------------------------------- |
| 1   | Accessibility       | `ux`                  | 4.5:1 contrast, alt text, keyboard nav, aria-labels         |
| 2   | Touch & interaction | `ux`                  | 44x44px targets, 8px+ spacing, loading feedback             |
| 3   | Performance         | `ux`                  | WebP/AVIF, lazy loading, reserved space (CLS < 0.1)         |
| 4   | Style consistency   | `style`               | one style throughout, SVG icons - never emoji               |
| 5   | Layout & responsive | `ux`                  | mobile-first, no horizontal scroll, zoom not disabled       |
| 6   | Typography & colour | `typography`, `color` | 16px base, 1.5 line-height, semantic tokens not raw hex     |
| 7   | Animation           | `gsap`                | 150-300ms, motion carries meaning, reduced-motion respected |
| 8   | Forms & feedback    | `ux`                  | visible labels, errors beside the field, helper text        |
| 9   | Navigation          | `ux`                  | predictable back, bottom nav <= 5 items, deep links         |
| 10  | Charts              | `chart`               | legends, tooltips, never colour alone to convey meaning     |

## Domains

`style` `color` `typography` `google-fonts` `product` `landing` `ux` `icons` `gsap` `chart`
`react` `web` — omit `domain` and it picks one from the question. Pass `stack` for framework rules:
react, nextjs, vue, svelte, astro, nuxtjs, nuxt-ui, html-tailwind, shadcn, swiftui, react-native,
flutter, jetpack-compose, angular, laravel, threejs, javafx, wpf, winui, avalonia, uno, uwp.

Deeper reference lives beside this file: `references/quick-reference.md` (all 98 UX rules with
rationale) and `references/pro-rules.md` (app polish + the pre-delivery checklist).

## Rules

- **Detect the stack, never assume it.** Check `package.json`, `pubspec.yaml`, `*.xcodeproj`,
  `composer.json`. A hardcoded default silently misroutes every recommendation.
- Use the returned values **as given** - the hexes, durations and easings are chosen to work
  together. Half-applying a style reads worse than not applying it.
- Accessibility outranks aesthetics. A design that fails contrast is not finished.
- One style per product. Mixing flat and skeuomorphic, or two icon sets, reads as unfinished.
- The corpus recommends; it doesn't decide. If the user asked for something specific, they win.

---

Corpus vendored from [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
(MIT, see `LICENSE.upstream`). Upstream ships a Python CLI; ada runs a Node port of the same BM25
ranking, verified to return identical results.
