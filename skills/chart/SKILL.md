---
name: chart
description: Chart, graph or plot data — pick the right visualization for the message (bar, line, pie, scatter, histogram, area, sankey, gantt) and render it inline, as mermaid, as SVG, or as a native slide/doc chart.
category: docs
---

# Chart

Use whenever the answer is a set of numbers and a picture would land better than a table.

1. **Say the message first** in one sentence ("revenue grew 3× but margin fell"). The chart's only job
   is to make that sentence obvious at a glance.
2. **Pick the type from the message**, not from the data shape:

   | The message is…                   | Chart                                  | Notes                                                                |
   | --------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
   | change over time                  | line (area if a total matters)         | time on x, always left→right                                         |
   | comparison between items          | bar — horizontal when labels are long  | sort by value, not alphabetically                                    |
   | parts of a whole                  | pie/donut, ≤5 slices                   | a sorted bar is usually clearer; stacked bar if it's parts over time |
   | relationship between two measures | scatter                                | add a trend line only if you name the correlation                    |
   | distribution of one measure       | histogram (box plot to compare groups) | state the bin width                                                  |
   | one number that matters           | big number + sparkline                 | no axes needed                                                       |
   | flow between stages               | sankey / funnel                        | values must conserve across stages                                   |
   | two-axis positioning              | quadrant                               | label all four quadrants                                             |
   | schedule                          | gantt / timeline                       |                                                                      |

3. **Pick the medium by where it has to live** — the four routes are below. Prefer the cheapest one
   that actually delivers.
4. **Render it, then say where it went** — print the absolute file path for anything written to disk.

## Route 1 — inline in the reply (default for ≤ ~12 values)

Costs nothing, needs no file, and stays in the transcript. Bars from `█▉▊▋▌▍▎`, sparklines from
`▁▂▃▄▅▆▇█`. Right-align labels, scale to the widest bar, and always print the value:

```
Q1  ████████████████████  1,240
Q2  ██████████████        860
Q3  ███████████████████   1,180
Q4  ████████████████████████████  1,730
```

## Route 2 — mermaid (fastest real chart; renders on GitHub and in most viewers)

Put it in a ` ```mermaid ` fence in a doc, or render + open it with the **diagram** skill.

```
xychart-beta
  title "Revenue by quarter"
  x-axis ["Q1", "Q2", "Q3", "Q4"]
  y-axis "USD (k)" 0 --> 2000
  bar [1240, 860, 1180, 1730]
  line [1240, 860, 1180, 1730]
```

Also: `pie title Share` with `"Label" : 42` rows; `quadrantChart`; `sankey-beta` (plain
`source,target,value` CSV rows); `gantt`; `timeline`. The `-beta` types need a current mermaid — the
diagram skill's HTML template pulls the latest from a CDN, so they need internet.

## Route 3 — SVG file (offline, any chart type, embeds anywhere)

When mermaid can't express it, it must work offline, or it has to be embedded in a page or README.
Use the **chart-svg** skill for the recipe.

## Route 4 — inside a deck or document

`generate_pptx` / `generate_docx` take a `chart` block (bar) and a `metrics` block (up to 4 KPI
tiles). Those stay native and editable in Office, so prefer them for bars and KPIs. For any other
type, render a **PNG** and pass it as an `image` block — those tools embed png/jpg/gif, not SVG.

## Rules

- One chart, one message. Two messages = two charts.
- Bar and area charts start the y-axis at zero. Truncating a bar axis exaggerates the difference.
- Label the axes with units. A bare number with no unit is not a chart, it's a decoration.
- Sort categorical bars by value; keep time in chronological order regardless.
- Don't use a second y-axis, 3-D, or a pie with 8 slices — all three mislead more than they show.
- Never invent or smooth data points to make the line prettier; plot what the numbers say, and say so
  when a gap is missing data rather than zero.
