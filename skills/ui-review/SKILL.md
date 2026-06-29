---
name: ui-review
description: Critique a UI for visual quality, consistency, and hierarchy, returning specific, prioritized fixes
category: ui-design
---

# UI Review

Use this to evaluate an existing screen with a senior designer's eye and produce concrete, actionable critique — not "looks good" but "the h2 and body are too close in size; bump the scale ratio to 1.25."

1. Read intent first: what is this screen for, what's the one primary action? Judge everything against whether the design serves that goal and points the eye to it.
2. Check hierarchy with the squint test: blur your vision (or zoom to 50%) and confirm the most important element dominates. If everything competes, that's finding #1.
3. Audit consistency: collect the distinct spacings, font sizes, colors, radii, and shadows in play. Off-scale or near-duplicate values (15px vs 16px, two almost-equal grays) are concrete defects to list.
4. Measure the fundamentals: contrast ratios on text (AA 4.5:1), body measure (60–75ch), alignment to a grid, and spacing rhythm. Flag exact violations with the failing value.
5. Inspect states and motion: are focus-visible, hover, empty, loading, and error handled? Are transitions tasteful (120–250ms, eased) or janky/missing?
6. Assess the aesthetic: is there a point of view, or does it read templated? Name the one change that would most raise perceived quality.
7. Return findings ranked by impact, each as observation → why it hurts → specific fix, separating must-fix from nice-to-have.

## Rules
- Every critique is specific and actionable — name the element, the failing value, and the fix.
- Lead with hierarchy and consistency; they drive perceived quality more than color choice.
- Cite measurable thresholds (contrast, measure, spacing scale) instead of vibes.
- Prioritize: 3 high-impact fixes beat 30 nitpicks.
- Acknowledge what works so good decisions survive the next iteration.
