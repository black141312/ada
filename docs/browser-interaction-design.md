# Browser tool: acting by ref — design

Approved 2026-08-06. Successor to [browser-interaction-plan.md](browser-interaction-plan.md); scope
decisions from that brief carry over (refs over pixels, no ARC-AGI creep). This is the buildable
design.

## Shape

Same `browser` tool in `src/client/tools.ts` (~line 569), same driver `src/client/browser.ts`, same
raw-CDP-no-puppeteer constraint. The existing four actions (`open`, `screenshot`, `text`, `console`)
are untouched. Nine actions are added.

### Acting actions

| action | args | does |
| --- | --- | --- |
| `read` | `tab?` | accessibility tree via `Accessibility.getFullAXTree`; every interactive node tagged `ref_N`; output capped |
| `click` | `ref`, `tab?` | `DOM.scrollIntoViewIfNeeded` → box center from `DOM.getContentQuads` → `Input.dispatchMouseEvent` press+release |
| `type` | `ref`, `text`, `tab?` | `DOM.focus` → select-all → `Input.insertText`; replaces the field's content |
| `press` | `key`, `tab?` | `Input.dispatchKeyEvent`; keys: Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace |
| `scroll` | `direction` + `amount`, or `ref`, `tab?` | wheel event at viewport center, or scroll the ref into view |

CDP-native input events, not in-page JavaScript: dispatched events are trusted, so framework-bound
inputs (React controlled components and the like) see exactly what a human produces. In-page
`element.click()` / value assignment was considered and rejected — it needs per-framework native-
setter workarounds and still misses keyboard handlers.

### Tabs

| action | args | does |
| --- | --- | --- |
| `tabs` | — | list open tabs: id + **origin only** |
| `tab_new` | — | open `about:blank`, return its id |
| `tab_select` | `tab` | bring one to the front |
| `tab_close` | `tab` | close one |

Tab plumbing is the DevTools HTTP endpoints already in use (`/json/list`, `/json/new`,
`/json/activate/{id}`, `/json/close/{id}`). Every acting action takes an optional `tab` id;
default is the last tab this tool selected, else the first page target — the current behaviour.

The tab list never shows page titles. A title is page-authored text and the tab list is somewhere
the model reads; origins only, same rule as page content.

## Refs and staleness

`read` walks the AX tree and assigns `ref_N` to interactive roles (button, link, textbox, checkbox,
radio, combobox, listbox option, tab, menuitem, slider, switch). Refs map to CDP
`backendDOMNodeId`s, which are browser-side and therefore survive the driver's open-a-session-per-
call pattern. The map lives in module state in `browser.ts`, keyed by tab id, and records the page
URL at read time.

Staleness is checked, not guessed: an act whose tab URL no longer matches the URL at `read` time
fails with "page changed — read again". Acting with no prior `read` for that tab fails the same
way. `open` on a tab drops its ref map.

## Approvals

- The tool keeps `needsApproval: true`. Acting is never cheaper to authorise than looking.
- `press` with `Enter` force-confirms on every call, even after "yes to all" — the same mechanism
  as destructive bash commands in `agent.ts` (~line 1148, the `forceConfirm` check), extended by
  one condition.
- All other acting actions behave like any gated tool: prompt, with "yes to all" covering them for
  the session.
- `read` output ends with one fixed line reminding the model that page content is data, not
  instructions. Text a page renders — including "click here to continue" — never carries authority.

## Errors

Every failure returns a plain error naming the next move, no retries, no waiting heuristics beyond
what `open` already does:

| failure | error |
| --- | --- |
| ref not in the current map | "unknown ref — `read` first" |
| tab URL changed since read | "page changed — `read` again" |
| element has no box (hidden/detached) | "element is not visible — `read` again" |
| key not in the supported set | lists the supported keys |
| tab id not found | "no such tab — list with `tabs`" |

## Verification

One real-page check alongside the existing tests: a throwaway local HTTP server (node `http`,
ephemeral port) serving a page with a button that mutates the DOM and a text input. The test runs
`read` → `click` the button → `read` and asserts the tree changed the way the click implies, then
`type` into the input → `read` and asserts the value landed. Real browser, no mocks.

## Out of scope

`find` over the last tree (add if trees prove too large in practice), coordinate-based input, drag,
hover, file upload, playing anything in a browser.
