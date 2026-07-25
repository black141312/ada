---
name: chart-svg
description: Hand-author a dependency-free SVG chart, graph or plot — line, bar, scatter, area, histogram, donut — that works offline and embeds in any page.
category: graphics
---

# Chart SVG

Use when a chart must be a real file — offline, embedded in a README or HTML page, or a type mermaid
can't express. No libraries, no build step: SVG is text, so `write_file` is the whole toolchain.

1. **Fix the frame.** `viewBox="0 0 640 360"` with no `width`/`height` so it scales to its container.
   Reserve margins for the axes: left 56, right 16, top 40, bottom 24 — so the plot area is
   568 × 296, spanning x `56→624` and y `40→336`.
2. **Compute the scales in your head before writing any path** — get `min`/`max` of the data, round
   the max _up_ to a nice tick (1/2/5 × 10ⁿ), and write the two mappings down:
   - `x(i) = 56 + i * (568 / (n - 1))` (or `+ band/2` for bars)
   - `y(v) = 336 - (v / yMax) * 296` (y grows downward — this is the #1 source of upside-down charts)
3. **Draw back to front:** gridlines → axes → data → labels. Later elements paint over earlier ones.
4. **Emit the marks** — every type is one of these:
   - line: `<polyline fill="none" stroke="…" stroke-width="2" points="x,y x,y …"/>`
   - area: the same points, then back along the baseline, as a closed `<polygon>`
   - bar: one `<rect>` per value, `width = band * 0.7`, `y = y(v)`, `height = 336 - y(v)`
   - scatter: one `<circle r="4">` per point
   - donut: a `<circle>` per slice with `stroke-dasharray="len gap"` and a `stroke-dashoffset`
     running total — no arc maths needed
5. **Label everything**: 4–5 y ticks with `text-anchor="end"`, x labels with `text-anchor="middle"`,
   a `<title>` for accessibility. Set `font-family="system-ui, sans-serif" font-size="12"`.
6. Write it to `docs/<name>.svg` (or a scratch path if it's throwaway), then print the absolute path.

## Skeleton

```svg
<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>Revenue by quarter</title>
  <g stroke="#8884" stroke-width="1">
    <line x1="56" y1="336" x2="624" y2="336"/>   <!-- x axis -->
    <line x1="56" y1="40"  x2="56"  y2="336"/>   <!-- y axis, plot top = 40 -->
  </g>
  <g fill="#888" font-family="system-ui, sans-serif" font-size="12">
    <text x="48" y="340" text-anchor="end">0</text>
    <text x="48" y="44"  text-anchor="end">2000</text>
    <text x="127" y="354" text-anchor="middle">Q1</text>
  </g>
  <!-- band = 568/4 = 142, centre 127, bar 0.7 wide; 1240 of 2000 -> y = 336 - 0.62*296 = 152 -->
  <rect x="78" y="152" width="99" height="184" fill="currentColor" opacity="0.85"/>
</svg>
```

## Rules

- **Verify the geometry before you claim it works**: every `y` must land in `[40, 336]` and every `x`
  in `[56, 624]`. A value outside the plot area is a scale bug, not a rendering quirk.
- Use `currentColor` (or `fill` set on the root `<svg>`) for the data marks so the chart inherits the
  page's theme, and semi-transparent greys for axes so it reads on light _and_ dark backgrounds.
- No external fonts, images, or scripts — a chart that needs the network isn't a file, it's a
  dependency. Keep it self-contained so it renders inside a README on GitHub.
- Escape `&`, `<`, `>` in any label text, and quote every attribute.
- SVG can't be embedded in pptx/docx. If it's headed for a deck or document, render a PNG instead
  (see the **chart** skill, route 4).
- If the data has more points than the plot has pixels, aggregate first — don't draw 5,000 overlapping
  circles and call it a scatter plot.
