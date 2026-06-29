---
name: dashboard-ui
description: Design a clean, scannable data dashboard — clear hierarchy, restrained color, and fast comprehension.
category: ui-design
---

# Dashboard UI

Reach for this when building an analytics or operations dashboard, where the job is to surface signal fast and let users act without hunting.

1. Lead with the answer: a top row of 3–5 KPI stat cards (big number, label, trend delta with direction color), then supporting charts, then granular tables — most important, top-left.
2. Lay out on a 12-column grid with consistent gutters and an 8px spacing rhythm; use container queries so cards reflow by their own width, not just the viewport.
3. Keep the palette near-monochrome for chrome (neutral surfaces, one muted border token) and reserve saturated color strictly for data and semantic states (up/down, success/warn/error) so meaning pops.
4. Set an information density that fits the user: align numbers right, use tabular figures (`font-variant-numeric: tabular-nums`), and tighten line-height in tables while keeping comfortable card padding.
5. Make charts honest and minimal: drop chartjunk, label directly over legends where possible, start bar axes at zero, and cap each chart to one clear question.
6. Provide structural states — loading skeletons matching card shapes, empty states with a next action, and persistent filters that don't reset on navigation.

## Rules
- Color carries data meaning; never decorate the UI with the same hues you use for series, or users misread the charts.
- Whitespace is a feature — resist cramming; a scannable dashboard beats a complete-but-dense one.
- Use semantic green/red for trends but never rely on color alone — pair with arrows/signs for color-blind users (contrast ≥3:1).
- Numbers are the hero: tabular figures, right alignment, sensible rounding and units; no jittering digit widths.
- Keep the navigation/chrome quiet so the data is the brightest thing on screen.
