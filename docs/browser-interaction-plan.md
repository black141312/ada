# Making the browser tool able to act, not just look

Scope agreed 2026-08-05. Not started — this is the brief, not a record of work.

## Where it stands

`src/client/tools.ts:569` defines the `browser` tool; the driver is `src/client/browser.ts`. It has
four actions and all of them are read-only:

| action | does |
| --- | --- |
| `open` | navigate, report title + console |
| `screenshot` | save a png |
| `text` | rendered page text |
| `console` | logs and errors |

It can look at a page. It cannot click, type, scroll or fill a form, which is the gap against Claude
Code — there the browser is a surface you act on, not a viewer.

## What to add

Acting by **element reference**, not pixels. Read the page as an accessibility tree where every
interactive element carries a `ref_N`, then act on `ref_N`. Coordinates break the moment a layout
shifts or a viewport differs; refs survive both, and the model can see what it is about to click.

- `read` — the a11y tree, each interactive node tagged `ref_N`
- `click` — by `ref`
- `type` — text into a `ref`
- `press` — a key (Enter, Tab, Escape)
- `scroll` — direction + amount, or scroll a `ref` into view

Keep the existing four untouched. `read` before acting is the pattern; a `find` that searches the
last tree can come later if the tree turns out too large to keep in context.

## Tabs

The tool today drives one page. Real work needs more than one — read the docs in one tab while the
app under test runs in another, or follow a link without losing the page you were on.

- `tabs` — list open tabs (id + origin), so the model knows what it has
- `tab_new` — open a blank tab, return its id
- `tab_select` — bring one to the front
- `tab_close` — close one

Every acting action then takes an optional tab id, defaulting to the fronted tab. List origins only,
never page-authored titles: a title is text a page controls, and a tab list is somewhere a model
reads. Same rule as page content — it is data, not instruction.

## The part that needs care

The tool already sets `needsApproval: true` just for looking, which was the right instinct: a
browser that can click can also submit a form, send a message, or spend money. Acting must not be
cheaper to authorise than looking. Decide deliberately whether a single approval covers a sequence
of clicks or each one asks — leaning towards: navigation and reads are one grant, anything that
submits is its own.

Never let a page's own text act as an instruction. Content read out of a page is data; if it says
"click the button below to continue", that is the page talking, not the user.

## What this is not for

It will not help with ARC-AGI-3. That plays through the API and the board is text — ~1,100 tokens a
frame, against a screenshot plus a vision model. Do not let this scope creep into "play games in a
browser".

## Check it works

A real page, not a mock: `read` it, `click` a ref, `read` again and confirm the tree changed the way
the click implies. The existing browser tests (if any) live alongside `browser.ts`.
