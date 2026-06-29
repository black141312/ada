---
name: html-table
description: Build an accessible, responsive data table with sortable columns, proper headers, and a sensible mobile layout.
category: html
---

# HTML Table

Use for presenting tabular data (dashboards, reports, listings). The goal is correct table semantics plus optional client-side sorting that stays accessible.

1. Use real table structure: `<table>` with `<caption>`, `<thead>`, `<tbody>`, and `<th scope="col">` / `<th scope="row">` so screen readers announce header context.
2. Add sorting on `<th>` headers: a `<button>` inside the header cell, `aria-sort="ascending|descending|none"` reflecting state, sorting `<tbody>` rows in JS (stable sort, type-aware for numbers/dates).
3. Keep keyboard support: header sort controls are real buttons (focusable, Enter/Space activate); don't trap focus.
4. Handle overflow responsively: wrap in a scroll container (`overflow-x:auto` with `tabindex="0"` and an `aria-label`), or restructure to stacked cards under a breakpoint with data labels.
5. Style for scanability: zebra striping via `:nth-child`, sticky `<thead>` for long tables, right-align numeric columns, and clear sort-direction indicators.
6. For large datasets add pagination or virtualization rather than rendering thousands of rows; announce row counts and sort changes via a polite live region.

## Rules
- Tables are for tabular data only — never for page layout.
- Always include `scope` on header cells (and `headers`/`id` for complex multi-level headers).
- Reflect sort state in `aria-sort` and keep the sort control a real `<button>`, not a clickable `<div>`.
- Provide an accessible name (`<caption>` or `aria-label`) describing what the table contains.
- For horizontal scroll, make the scroll container keyboard-focusable so it's reachable without a mouse.
