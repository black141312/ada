---
name: slide-charts
description: Add native charts and tables to slides from data using python-pptx chart and table APIs.
category: pptx
---

# Slide Charts

Use when a slide needs to visualize numbers — trends, comparisons, breakdowns — or present structured rows of data.

1. Get the data into a clean structure (lists/dict or a DataFrame) and decide the message the chart must make obvious.
2. Pick the chart type for that message: line for trend, bar/column for comparison, pie/doughnut sparingly for parts-of-whole.
3. Build a `CategoryChartData` with `.categories` and one or more `.add_series(name, values)`.
4. Place it with `slide.shapes.add_chart(XL_CHART_TYPE.<TYPE>, x, y, cx, cy, chart_data)` using `Inches(...)` coordinates.
5. Style for clarity: title, data labels where useful, legend only if multi-series, and brand colors on the series fill.
6. For tabular data use `shapes.add_table(rows, cols, ...)`, bold the header row, and keep it to the columns that matter.

## Rules
- Native python-pptx charts stay editable in PowerPoint; only fall back to an image (matplotlib export) when a chart type isn't supported.
- One chart, one message — don't overload axes or stack unrelated series.
- Label axes and units; never show a bare number with no context.
- Avoid 3-D effects and chart junk; they distort perception and hurt readability.
- Keep tables small (rough max ~6 columns, ~8 rows) — dense grids belong in an appendix or handout.
- Sort categories meaningfully (by value or time), not alphabetically by default.
