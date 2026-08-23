# Changelog

All notable changes to ada are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [0.16.4] — 2026-08-23

### Fixed — ada stops resizing the window you are looking at

Every browser action set `Emulation.setDeviceMetricsOverride` to 1280x800. That is right for ada's own
scratch browser, where a fixed viewport makes screenshots comparable between runs. Applied to the
user's real browser it squeezed the page they were reading into 1280x800 inside a much larger window,
letterboxed in black — and because `BridgeSession` stays attached deliberately (detaching per action
would flicker Chrome's "ada bridge is debugging this browser" bar), the override was never cleared.
One `browse` left the tab squeezed until Chrome restarted. Measured on a live tab: 1920x889 forced
down to 1280x800 and left there.

The override now applies only to ada's own browser, or when a caller explicitly asks for a `width` or
`height`. A window somebody is looking at is theirs to size.

### Fixed — ada stops blanking the tab it is about to read

When the bridge had not connected yet, ada launched the user's Chrome to side-load the extension,
handing it `about:blank`. A running Chrome ignores `--load-extension` — the code said as much — so the
launch could not do its job. What it *could* do was open that blank tab and focus it. `browse` then
read the active tab and reported "your browser is currently on a blank page", while the page the user
was asking about sat one tab away.

Measured on a real window: active tab went from `Interleaving String - LeetCode` to `about:blank`, one
tab added, and another left behind on every session that started before the extension dialled in.
Five had accumulated.

Ada now checks whether that browser is already running and skips the launch when it is: there is
nothing it can achieve there, and the only thing it reliably achieved was taking the user's tab.

## [0.16.3] — 2026-08-23

### Changed — quotas are capped on spend per 4 hours, and the free tier is a price rule

Quotas were tokens per month, which prices a $25/1M model the same as a $0.10/1M one — so the only
free tier safe to offer was one that assumed the worst. The tier actually offered, OpenRouter's
`:free` pool, shares its upstream quota with every OpenRouter user, is exhausted most of the day, and
answers 429/404 — which reads as "ada is broken", not "the free tier is busy".

Usage is now costed from models.dev prices at read time and capped on **spend**: $0.50/4h free,
$2/4h pro, uncapped team (billed by contract, so metering it is reporting rather than gating). Four
hours rather than a month, because a monthly cap lets one bad afternoon burn the whole allowance and
leaves the account dead for three weeks; a short window fails small and recovers on its own.

The free tier is a price rule, not a list of ids: anything at or under $0.60 blended per 1M, tunable
with `ADA_FREE_MAX_PRICE`. A hand-written list goes stale the week a lab reprices and nobody
notices, because nothing breaks. An unpriced model is never free — fail closed.

`/v1/plan` reports `usedUsd`/`capUsd`/`resetsAt`; `used` stays in tokens, because the composer's live
turn meter reads it to show a turn's own consumption. A per-user override moves from `max_tokens` to
`max_usd`, the same unit as the plan, and analytics ranks accounts by real spend rather than by a
token total that cannot be costed once cheap and expensive models both count.

Also fixes `test/plans.mjs` and `test/billing.mjs`, which had been failing on `authDatabase.prepare()`
since it became a function.

### Fixed — `.gitignore` covers the sqlite sidecars

`ada-auth.db` was ignored but not the `-journal`, `-wal` and `-shm` files sqlite writes beside it, so
a stale journal sat untracked in the tree — and `npm run release` refuses to tag a dirty one.

### Fixed — ada no longer answers about the wrong browser, silently and forever

Two faults that compounded into one bad afternoon: ada reporting a scratch browser's contents as the
user's own, confidently, with no way for them to tell.

- **The transport was decided once and never revisited.** Whether the bridge could reach the user's
  Chrome was settled at the first browser action and cached for the life of the process. A session
  that happened to start while the extension was reloading, or while another ada held port 9223, was
  demoted to ada's own profile permanently — the extension could return a second later and that
  session would never look again. It now re-checks: success stays sticky, because switching browsers
  mid-session is the confusion this arrangement exists to avoid, but failure is retried — immediately
  if a bridge is already listening and the extension merely reconnected, otherwise once a minute.
- **The fallback said nothing.** Ada would open `leetcode.com` in its own logged-out profile, land on
  the homepage, and report "I found your open LeetCode tab, but it's on the main homepage" — while
  the user's real tab sat open in Chrome with their code in the editor. `tabs` already named which
  browser it read; every other verb did not. Results from the scratch profile now carry a one-line
  note saying so, so the model repeats it instead of guessing.

`--disable-features=CalculateNativeWinOcclusion` cannot help on the bridge path: that browser is the
user's, already running, and ada cannot relaunch it. A coordinate click into an occluded window is
still dropped there.

### Fixed — ada opens the Chrome profile that actually has the extension

The bridge extension is per-profile: it is loaded into one profile, and only that profile's tabs are
reachable through it. Ada launched `Default` regardless, and `ADA_CHROME_PROFILE` was the only way to
say otherwise — an env var named after Chrome's internal directory (`"Profile 6"`), documented
nowhere. Worse, it barely worked: `--load-extension` is ignored when Chrome is already running, which
for most people it always is, so pointing ada at a profile without the extension just fell through to
its own scratch profile with none of your logins. Silently.

Ada now reads which profiles carry the extension and launches one of those:

- exactly one has it — use it, no question asked;
- several have it — ask, listing them by the name you know (`adacodelabs.com — admin@…`), not
  `Profile 6`, and remember the answer in `chromeProfile`;
- nothing to ask on (print mode, `serve`, cron) — take the profile Chrome itself used last rather
  than block on a prompt nobody can answer;
- none have it — open the profile you actually work in and side-load there, as before.

A saved choice is honoured only while that profile still carries the extension. Otherwise ada would
keep launching a browser it cannot drive and fall back silently every time — the original bug wearing
a settings key.

### Fixed — ada stops claiming it has no browser

`browse` was lazy: advertised to the model only when the turn matched a regex of dev words —
`localhost`, `devtools`, `screenshot`, `console`, `preview`, `in chrome`. So "can you get me the top
email from gmail" advertised nothing, and the model answered that it had no access to email at all.
That answer was accurate: the tool genuinely was not in its list. Nine of ten ordinary browser
requests missed the gate, including `open gmail`, `go to leetcode and read the problem`, and the typo
`use broswer` — the fix a user reaches for when the first answer is wrong.

The gate saved ~244 tokens a turn and cost a wasted round trip whenever it missed, so it was losing on
its own terms. `browse` is now advertised unconditionally. The expensive tool is the raw `browser`
schema — 25 verbs and a screenshot per step — and that stays `hidden`, reachable only by the cheap
`browse` sub-agent, which is the arrangement worth keeping.

The description was the other half: it read as a tool for checking your own UI work and reading a
page's console, and never said the browser carries real logins. It now leads with that, so reaching a
page behind a sign-in is an obvious use rather than one you have to think of.

## [0.16.2] — 2026-08-21

### Added — `rlm`, and a strategy chosen per request

- **`--strategy rlm` answers from a source too big to read.** A question about something that does not fit
  the window had one answer until now: `compact`, which summarizes the transcript *before* the question is
  asked, so whatever the summary dropped is gone. `rlm` never summarizes. It chunks the source, gives one
  worker per chunk the question already in hand, and answers from their notes — the root model never sees a
  byte of the source. Chunks overlap by 2k so a fact on a boundary is not missed by both neighbours, and
  `rlmFold` recurses only once the notes outgrow the answering model, because a fold that fires when it need
  not costs recall for nothing (8/17 folded vs 16/17 unfolded on the same question). Measured on real files:
  4/4 finding .pem paths in a 10MB listing, 67/68 pre-1.0 packages in a 251k lockfile, 16/17 directories in
  that same listing, and no fabricated results in any run.
- **`strategy` is a settings key, and the new `auto` routes per request.** It was flag-only, so every session
  started in `react` unless you remembered `--strategy`; it now resolves flag > `ADA_STRATEGY` >
  `settings.json` like every other default. `auto` asks the cheap signals first and a model only when they do
  not decide, because a classifier on every turn taxes every "what does this do?" to serve the rare request
  where the answer is interesting: a named source bigger than one chunk goes to `rlm`, anything under 120
  characters or opening like a question goes to `react`, and the rest costs one word from the worker model.
  An unrecognised answer falls back to `react` — a failed router should cost you the plan phase, never the
  turn. `single` and `toolsmith` are never routed to.

### Added — a GUI can drive orchestration and watch it run

- `strategy` joins model/mode/reasoning on `POST /v1/sessions` and `PATCH /v1/sessions/:id`, and rides the
  same per-turn sync, so flipping it mid-conversation applies from the next prompt. An unknown name is a 400
  that names the valid ones rather than a silent fallback to `react`, which reads as "the setting did
  nothing" — the worst outcome for a control somebody just flipped. `session({strategy})` and
  `AdaSession.setStrategy()` mirror it in the SDK.
- **A `progress` event, and `Engine.note()` to emit it.** Every orchestrator status line went through
  `say()`, which becomes a `text` event when a caller is listening — so "175 workers" arrived as part of the
  assistant message, ANSI escapes and all. `note()` takes plain text and each surface formats it: dim
  (yellow for warn) in a terminal, a status line in a GUI.

### Added — analytics can say when usage happens, and how fast it answered

- **Latency is kept.** `ms` and `ttftMs` were measured at the call site, handed to the JSONL writer, then
  dropped at the table — so on a hosted box, where that file is ephemeral, latency could not be analysed at
  all. They are columns now, and the dashboard shows p50/p95 for both, computed by ordering rather than
  averaging: latency is long-tailed and a mean sits under most of the pain.
- **Rough location, without holding an address.** Clients send their IANA zone (`x-ada-tz`); country is kept
  only when a proxy in front of us already resolved one, and is never looked up. `ADA_NO_TZ=1` opts out.
  Hour-of-day is bucketed in each user's own local time, so the chart reads as "when do people work" rather
  than "when is the server busy" — bucketed by quarter hour, because India is +5:30 and Nepal +5:45, and
  flooring to hours before shifting put 09:00 IST in the 08:00 column.

### Changed — local embedding chunks at 30 lines

MiniLM truncates at 512 tokens. An 80-line code chunk tokenizes to a median 1176, so the tail was cut and
those lines became unreachable by search — no query could reach them, and nothing anywhere said so. Measured
over this repo's `src/`: at 80 lines, 89% of chunks were truncated and 42% of the content was ever embedded;
at 30 lines, 36% and 90%. The cost is one slower first index (9.2s → 22.3s over `src/`, 498KB → 1.2MB on
disk); peak memory is unchanged, since attention scales with seq² and the shorter sequences offset there
being more of them.

`FORMAT` bumps to 3 because it has to: staleness is per-file by content hash, so without it an unchanged file
would keep its 80-line ranges while edited files got 30 — one index holding two chunk sizes, the old half
still carrying the truncated vectors this removes. **Everyone re-indexes once.**

Each embed batch is also length-sorted. Padding is per-batch, so one long text inflated every short one next
to it; grouping by length cut peak memory from 673MB to 598MB over the same work, at the same wall time.

### Fixed — the browser tool acts on the page again

Three faults, each of which let an action report success while the page never saw it.

- **The bridge stopped answering after its first command.** The extension starts a `connect()` loop from four
  places (`onInstalled`, `onStartup`, the 30s alarm, and worker wake) and every failed attempt scheduled
  another, so the loops multiplied instead of replacing each other — each holding its own stream socket open.
  Six of them reach Chrome's per-host connection limit, at which point the extension's `POST /result` can no
  longer get a connection: commands ran in the browser and their answers were lost on the way back. It
  surfaced as every op timing out a few seconds after the first one worked. The bridge now closes a
  superseded stream, and the extension refuses to start a second connect loop.
- **Clicks were dropped on a freshly launched browser.** On Windows a window that opens behind the user's
  other windows is reported fully occluded, and Chrome then marks the renderer hidden and throttles it —
  synthetic `Input.*` events are discarded on a hidden widget while the dispatch still reports success, so a
  click "succeeded" and the page never saw a mousedown. `--disable-features=CalculateNativeWinOcclusion`
  keeps the renderer live. It only looked flaky because a window that later became visible stayed working for
  the rest of its life.
- **`read` answered differently depending on the transport.** Over the debug port it returned the full
  accessibility tree; over the bridge, only the interactive elements — so `click` then `read` to confirm a
  result showed nothing had changed, which is indistinguishable from the click having failed. The bridge now
  reports the page text too, names elements by ARIA role (`textbox`, `link`, `combobox`) instead of tag name,
  and renders a control's current value the way the accessibility tree does. `npm run check:browser` now
  passes over the bridge as well as the debug port.

### Added — `reload` on the browser bridge

Editing `extension/background.js` otherwise means a human clicking reload on `chrome://extensions` — the one
page `chrome.debugger` may never attach to — because Chrome keeps serving the registered worker script, not
the one on disk. **Upgrading to this release does not reload the extension for you: reload it once by hand,
after which ada can do it.**

## [0.16.1] — 2026-08-17

### Fixed
- Local embedding now indexes in batches of 8. A large repo handed the whole corpus to onnxruntime
  in one call, which could exhaust memory and take the backend down with it — so the feature meant
  to make context cheaper was the one that killed the process.

This fix (#94) was on `main` before 0.16.0 was published but missed the tag, so 0.16.0 on npm does
not contain it. Nothing else differs between the two releases.

## [0.16.0] — 2026-08-17

### Added — the browser tool can actually automate things

Looking at a page and *driving* one are different jobs. The tool could do the first well and the
second barely: refs came only from an accessibility-tree `read` and went stale on every navigation,
every wait was a blind 300 ms sleep, and there was no way to fill a form, pick from a dropdown,
attach a file, or read structured data back out.

- **Target elements by CSS `selector` or by visible text (`find`)**, not just `ref_N`. Selectors and
  text survive re-renders; refs do not.
- **New verbs**: `wait` (for a selector, page text, or load — with `timeout`), `select`, `hover`,
  `fill` (many inputs in one pass), `upload`, `eval`, `drag`, `back`, `forward`, `reload`, `pdf`.
- `fill` and `select` write through the native value setter and dispatch `input`+`change`, so React
  and Vue see the value instead of silently ignoring it.
- `drag` walks the cursor in ten steps — HTML5 drag handlers ignore a teleporting mouse.
- **`screenshot` now shows the image inline as well as saving the file.** Saving one and not being
  able to see it was a strange default; `look` remains inline-only for loops that would otherwise
  flood the transcript.

### Changed — ada drives the system default browser, in a profile that remembers you

- The browser is now found by asking the OS which one opens `https://` (Windows registry, macOS
  LaunchServices, `xdg-settings`) instead of guessing Chrome-then-Edge. Non-Chromium defaults fall
  back to the old list, since only Chromium speaks CDP.
- **The profile persists** at `~/.ada/browser-profile` (override with `ADA_BROWSER_PROFILE`) instead
  of a fresh temp directory per run, so signing into a site is a one-time cost rather than a
  per-run one.
- **Headed by default.** Headless only under `ADA_BROWSER_HEADLESS=1`, in CI, or on a display-less
  Linux box. Automating real sites means occasionally seeing what went wrong and taking over.

### Fixed
- Oversized tool output spills to `.ada/tmp` on every path, not just `bash` and `git`. Everything
  else truncated silently, so the middle of a long read or search was simply lost; now the head and
  tail stay inline and the full text is retrievable. Spills older than a day are swept.
- A hung MCP connector can no longer wedge a turn. `tools/call` had no deadline at all — only
  `initialize` and `tools/list` did — so a server that accepted the call and never answered stalled
  the agent indefinitely. Now 5 minutes, with a 10-minute backstop on any tool lacking its own.
- Repeating an identical tool call three times now appends a reminder to the result, so the loop
  breaks itself instead of spending the turn re-reading the same file.
- `Page.navigate` no longer hangs the tool for 30 s. Some pages — anything running aggressive bot
  detection, or opening a JS dialog — never acknowledge the command even though the navigation
  commits. It now uses a 10 s timeout and ignores a missing ack; the `readyState` poll that follows
  is the real completion signal.

### Added — `npm run browser:login` and `npm run browser:profile`
`browser:login <site>...` opens ada's browser visibly with a tab per site so a human can sign in
once, by hand, with credentials that never pass through ada.

`browser:profile` clones a real Chrome profile's preferences, history and localStorage — but **not**
its logins, and it now says so loudly. Measured on Chrome 151: a profile with 3879 app-bound (`v20`)
cookies and 4 `li_at` entries came back with zero of each, because Chrome discards app-bound cookies
on first launch against a copy. Nor is there a flag around it — both `--remote-debugging-port` and
`--remote-debugging-pipe` refuse to attach to the default profile directory ("DevTools remote
debugging requires a non-default data directory"). Driving an already-logged-in Chrome would take a
browser extension using `chrome.debugger`; ada's own persistent profile is the supported path.

## [0.15.0] — 2026-07-30

### Added — plans and token quotas (replaces the allow-list)
An allow-list answers *"may this person in?"*. For a product anyone can sign up for the question is
*"what is this person entitled to?"*. Membership no longer gates chat: everyone authenticated gets
in, lands on `free`, and the plan decides the rest.

| plan | models | tokens / period |
|---|---|---|
| free | `:free` only | 2M |
| pro | all | 25M |
| team | all | 120M |

- **`403` vs `402`** — 403 means your plan doesn't include this model, 402 means you're out of quota.
  Collapsing them tells someone to upgrade when they already had.
- **A lapsed subscription degrades to free**, it doesn't lock out — an expired card should cost you
  the paid models, not your account. Unknown plan strings and failed lookups also resolve to `free`,
  which permits only `:free` models and so fails closed at zero upstream cost.
- **Paid periods anchor to the subscription date**, so the window matches what was charged; free
  gets the UTC calendar month.
- `GET /v1/plan` (self-serve) and `POST /v1/plans` (admin) — admin identity comes from
  `ADA_ADMIN_USERS` (still reading `ADA_ALLOWED_USERS` under its old name) and never from the table
  it edits, so a bad write can't lock the operator out of the server that would fix it.

### Added — usage persisted to the database
`appendUsage` writes JSONL to the data directory — right for a self-hosted box, useless for a hosted
one, since Cloud Run's disk is ephemeral and scales to zero. Nothing could be billed on it.
`usage_events` now carries the same row in Postgres (sqlite when self-hosting), indexed on
`(user_id, ts)` — the only query a quota makes. Stored as **tokens, not cost**: prices change, tokens
don't, so cost is derived at read time from the model on each row.

### Added — checkout sessions
Upgrading happens on the website, which is static and has no way to know who's asking. Rather than
putting the account token in a URL — where it lands in browser history and in the `Referer` of every
third-party asset — the app mints a session server-side and opens a link carrying only its id: 256
bits of randomness, single-use, 30-minute expiry, revealing nothing but the plan being bought.
`completeCheckout()` is idempotent, because payment providers replay events out of order.
`/v1/billing/webhook` answers **501** and is deliberately not stubbed: a webhook that accepts a body
and grants a plan is an unauthenticated way to give yourself Pro, and signature verification *is* the
security of a webhook.

## [0.14.1] — 2026-07-29

### Fixed — caching now works *within* a session, not just across identical requests
0.14.0 gave Claude prompt caching, but only repeated identical requests hit; turns inside a session
still missed. Anthropic folds every system message into one parameter that sits ahead of the whole
transcript, and the repo map (stable all session) shared that message with the per-turn hints
(memory recall, skill routing, plan mode) — so one changed byte of guidance rewrote the prefix and
invalidated everything behind it. The cache could not hit twice in a session by construction.

They're now sent separately: the repo map stays in `system` where it's byte-identical every turn,
and per-turn hints move to a trailing user message — after the cache breakpoint, so they cost their
own tokens and nothing else's. The breakpoint also moves one turn back, to the second-to-last
user/assistant message, since the newest turn can be transient; anchoring there would mint a fresh
cache entry every request and never read one.

| one session, three files read | tokens | cache | cost |
|---|---|---|---|
| before | 13,212 | none | $0.0786 |
| after | 15,550 | **32% hit** | **$0.0715** |

## [0.14.0] — 2026-07-29

### Fixed — headless runs were missing half the agent
- **`ada -p` registered no skills, no memory tools, and no `spawn_agent`.** Every headless and
  scripted run went out with none of the built-in skills loaded and no ability to delegate. Benchmark
  runs showing zero delegation read as "the model chose not to" — the tool was never registered.
- **`--json` silently disabled skill routing and memory recall.** It set `quiet`, and `quiet` also
  gated routing, so an output format changed what the agent did. Now split: `quiet` is stdout only,
  `delegated` marks a turn a parent agent already scoped.
- **`--strategy plan` failed on every run, and `--strategy multi` could not complete one.** Both
  appended a system message mid-orchestration; providers hoist system messages into a separate
  parameter, leaving the conversation ending on the assistant's own message — an assistant prefill,
  which Claude rejects with a 400. The Engine primitive is now `addUser`.

### Added — prompt caching for Claude on the OpenAI-compatible path
Claude is the only model family that must be *asked* to cache; DeepSeek, Kimi and OpenAI do it
automatically. Routed through OpenRouter nothing set `cache_control`, so every turn of every Claude
session re-sent the whole transcript at full price. Measured, same prompt twice: **$0.0323 → $0.0028
(100% cache hit)**.
- Requests `usage: { include: true }` from OpenRouter, which otherwise omits the cache breakdown and
  leaves a hit invisible.
- Reads both spellings — OpenRouter's `cache_write_tokens` and the native adapter's
  `cache_creation_tokens`. Reading one billed cache writes as fresh input.
- *Known limit:* turns **within** a session still miss. Per-turn extras (repo map, recalled memories,
  skill hints) ride as a trailing system message, and Anthropic folds all system messages into one
  parameter — so the system block changes each turn and invalidates the prefix behind it.

### Fixed — cost reporting
- Cached tokens were priced at the full input rate; cache reads bill ~0.1x and writes ~1.25x.
- Sub-agent spend wasn't counted at all, so a delegated run reported roughly a third of its cost.
- Tokens are tracked per model that served them, so `/model` mid-session no longer misprices.

### Changed — context
- Skill bodies are scoped to the request that loaded them instead of persisting in the transcript.
- Over-long tool output keeps its **head and tail** — for `npm install` or a test run the verdict is
  in the last lines, and head-only truncation hid it, costing a follow-up call to find it.
- Compaction triggers off the provider's real token count rather than a chars/4 estimate, and its
  summariser keeps both ends of the transcript (the tail alone lost the user's original goal).

### Removed — `--strategy multi`
It never reduced cost. On the same task it used **29x** the input tokens of plain `react`, and only
looked cheaper because workers ran on a model cheap enough to absorb the extra work; on the user's own
model it cost 2x `react` for worse output. Splitting one cohesive artifact along file lines leaves
nobody holding the whole design — the worker owning `script.js` wrote 5,096 bytes for a page that
needed 1,154, while the page lost gradients, an animation and a section. An unknown strategy falls
back to `react`, so existing scripts keep working.

Delegation itself stays: `spawn_agent` / `background_task` on a configurable cheap model
(`settings.subagentModel` / `ADA_SUBAGENT_MODEL`), each worker isolated in its own git worktree, with
a 50k prompt-token budget (`ADA_WORKER_BUDGET`).

### Added — built-in PPTX generation
- **`generate_pptx` tool.** ada can now produce a real, editable PowerPoint deck with zero external
  dependencies — no Python, no npm. The model emits structured JSON (slides with titles, subtitles,
  bullets with nesting, local images, speaker notes) and a deterministic renderer
  (`src/client/pptx.ts`, a from-scratch OPC zip + OOXML writer on top of `node:zlib`) turns it into
  a valid 16:9 `.pptx` — so even weak local models can make decks, since they only write content,
  never python-pptx code. Approval-gated like `write_file`; images keep their aspect ratio; input is
  lenient about common weak-model shapes (JSON-stringified arrays, newline-joined bullets). The
  `pptx-deck` skill now routes to the tool first, keeping python-pptx as the advanced path for
  corporate templates and on-slide charts.

## [0.13.0] — 2026-07-14

### Added — embeddable server + stable package surface (open-core seam)
- **`ada-agent/server` factory.** `src/server/index.ts` no longer listens on import — it exports
  `createAdaServer()` (builds the HTTP server without binding a port; validates OIDC config) and
  `startAdaServer(port?)` (the `ada-server` entrypoint). This lets a wrapper (e.g. a hosted control
  plane) construct or sit in front of the backend without forking it.
- **`exports` map in `package.json`** pinning the stable surface — `.` / `./sdk` (the typed client)
  and `./server` (the factory). Internals (`router.ts`, etc.) are now private-by-omission: deep
  imports like `ada-agent/src/server/router.ts` no longer resolve. *(The package ships `.ts` source,
  so library consumers load it via `tsx`.)*

### Added — docs
- **[docs/deploy-worker.md](docs/deploy-worker.md)** — host `ada-server` on Cloudflare Workers +
  point ada-ide at it (deploy, mint seat keys, wire the IDE). `wrangler.toml` gains the
  `OPENROUTER_API_KEY` secret + a seat-mint example.

## [0.12.3] — 2026-07-11

### Security — credential-leak hardening
Found by an adversarial multi-agent audit (loop-until-dry hunt → per-finding verification), then each
fix confirmed by hand and re-reviewed.

- **The `bash` tool no longer hands ada's secrets to the shell (CRITICAL).** It ran model-chosen
  commands with the full `process.env`, so a prompt-injected model could `echo $OPENROUTER_API_KEY` /
  `$ADA_ADMIN_KEY` / `$ADA_CLIENT_KEY` and exfiltrate the value in a tool result. The shell (and
  third-party **MCP** servers) now get a scrubbed env: ada's provider/admin/seat keys + auth secret are
  removed; `PATH`, `HOME`, and the user's own tool creds (`GITHUB_TOKEN`, …) pass through.
- **`BETTER_AUTH_SECRET` dev default is refused when accounts are enabled.** The server now fails to
  start if `BETTER_AUTH_ENABLED` is on and the secret is unset or left at the built-in dev value
  (which shipped in the repo → forgeable sessions).
- **Secret stores are written owner-only (`0600`).** `~/.ada/credentials.json` (provider keys + OAuth
  tokens), the seat store `users.json` (full `ada_sk_` keys), `settings.json` (`backendKey`), and
  session transcripts — previously world-readable, a risk on shared/Docker hosts. *(chmod is a no-op
  on Windows; this hardens POSIX/Docker.)*
- **Auto-memory secret gate** now also catches Google/Gemini `AIza…` keys and hyphenated `sk-ant-` /
  `sk-or-` provider keys.

## [0.12.2] — 2026-07-11

### Changed — REPL UI
- **A live "thinking" indicator** in the default prompt (previously only under `--tui`): a spinner +
  cycling verb + elapsed timer + `esc to interrupt`, cleared when the reply starts.
- **Replies stream inline** after the `◆` bullet (no `ada` label): `◆  <reply>`.
- **Tool approval is now an arrow-select list** — `Yes` · `Yes, and don't ask again this session` ·
  `No` — collapsing to a one-line confirmation after you choose (Esc / Ctrl-C → No, fail-safe).
- **Slimmer pre-prompt status line** — just `~N tok` (plus a `plan`/`auto` tag when in those modes);
  the model/provider stay in the startup header.
- Dropped the `↳ served by <model>` note (the status line already names the model).

### Added — skill
- **`render-diagram`** — draw a diagram inline in Unicode, or render mermaid to a self-contained HTML
  file and open it in the browser (composes `write_file` + `bash`; no new dependency).

## [0.12.1] — 2026-07-11

### Security
- **Better Auth is now opt-in (`BETTER_AUTH_ENABLED`).** Previously a Better Auth session token was
  honored on *every* request, so on a backend locked by seats / admin key / `ADA_CLIENT_KEYS` /
  allowlist / OIDC, anyone could self-register via the always-mounted `/api/auth/sign-up` and obtain
  dev access — bypassing the configured auth. Better Auth tokens are now honored only when
  `BETTER_AUTH_ENABLED` is set, and the resolved account is checked against the allowlist. Better
  Auth remains **experimental / off by default**.

### Fixed
- **`ada` no longer hangs at startup when a model provider is unreachable.** Identity verification
  (GitHub/Google) and the `/whoami` probe now have timeouts, and a dev-open backend short-circuits to
  `dev` before any network/DB auth call — so an offline machine (or an un-migrated Better Auth DB) can
  no longer wedge the CLI.
- The model picker no longer dead-ends when nothing is reachable — it offers `/connect` instead.

### Added — provider visibility
- `GET /v1/providers` reports every service the backend can route to and how each is configured
  (env / stored key / keyless), plus a live Ollama reachability probe.
- The startup header shows `model → provider` and a `services:` line (`openrouter ✓ · ollama ✗ …`);
  the status line shows `model@provider`. A `↳ served by <model>` note surfaces when an upstream
  resolves an alias id (e.g. OpenRouter's `~family`) to a different model than requested. These
  provider tags appear only for a local backend (the client's routing table can't speak for a remote).

### Added — model picker
- A curated **popular-models** shortlist (newest per family: Opus, Fable, Grok, Qwen, Kimi, DeepSeek,
  Gemini, GPT) leads the picker, plus "enter a model id" and "browse all". The chosen model now
  **persists** (`~/.ada/settings.json`), so subsequent launches boot straight to chat. `/model` (no
  arg) opens the picker; `/model <id>` warns on an unknown id with the closest match.

### Changed — UI
- Startup commands/mode render in a bordered block with aligned accent labels; the skills line is
  gone. The thinking indicator shows a live elapsed timer. Tool calls render Claude-Code-style
  (`⏺ Read(path)` + an indented `⎿ result`).

## [0.12.0] — 2026-07-09

### Added — /connect
`/connect` opens an arrow-select menu to connect ada to a provider (OpenRouter, OpenAI, Anthropic,
Cloudflare Workers AI, Groq, Google, Mistral, DeepSeek, xAI, Together, DashScope) — saving its API
key to the credential store so the local backend routes to it — or a custom backend / Cloudflare
Worker URL, saved to `~/.ada/settings.json`. Both **persist across sessions**: the client reads
`ADA_BACKEND_URL`, then the saved `backendUrl`, then localhost. Shortcuts: `/connect <provider>` or
`/connect <url>`.

## [0.11.0] — 2026-07-09

### Added — auto-memory
ada now remembers durable facts (preferences, conventions, decisions, gotchas) and auto-recalls the
relevant few at the start of each turn. Markdown-bullet store under `.ada/memory` (project,
trust-gated) + `~/.ada/memory` (global) — git-diffable, hand-editable. Recall reuses the lexical
`rankSkills` ranker (deterministic, offline), floored + capped (≤7 facts), and rides the per-turn
transient system-note seam so it is recomputed each turn and never persisted — context stays flat as
the store grows. Capture via a `remember_fact` tool with a hard secret-safety gate (refuse on write
AND at load), supersede-not-duplicate on same-subject value changes, and a `/memory` command surface
(list/add/forget/edit/pin/search/why/consolidate) + headless `ada memory`. Zero new dependencies.
Adversarially reviewed (fixed a secret-gate bypass + 5 more findings; selfcheck covers all).

## [0.10.1] — 2026-07-02

### Added
- `tool_result` agent events now carry the tool's `display` (its colored diff), so a client driving
  the session API (the IDE panel over `ada serve`) can render real diffs instead of plain text.

## [0.10.0] — 2026-07-02

### Added — Cloudflare Worker backend (edge-native port)
An edge-native port of the routing backend in `src/worker/` (deploy config `wrangler.toml`, schema
`src/worker/schema.sql`) — a self-contained Workers `fetch` handler: auth (D1 seats + admin key), the
org model-allowlist, and provider passthrough with server-side metering. **Cloudflare Workers AI
(`@cf/*`) is the first-class provider.** Use *either* this Worker *or* the container, not both. See
[docs/deploy.md](docs/deploy.md).

- Endpoints match the Node backend: `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, and the
  admin `/v1/users` · `/v1/policy` · `/v1/usage` · `/v1/audit`. Stores are strongly-consistent **D1**.
- Metering via a `TransformStream` tee + `ctx.waitUntil`; auth is prototype-safe by construction
  (parameterized `WHERE key = ?`). Verified against a local D1 (miniflare): seat CRUD, allowlist
  denial (403), admin gating (403), prototype-key rejection (401), usage aggregation. `wrangler
  deploy --dry-run` bundles clean (~18 KiB).
- **Deferred** (the Worker returns a clear error meanwhile): native Anthropic — reach Claude via
  OpenRouter or a Cloudflare AI Gateway; and OIDC SSO — needs a Web Crypto port of `oidc.ts`
  (`node:crypto`/`node:net` aren't on Workers).

### Changed
- CI typechecks the Worker (`npm run typecheck:worker`); `@cloudflare/workers-types` added as a devDep.

## [0.9.0] — 2026-07-02

### Added — deployable backend (container)
- **`Dockerfile` + `docker-compose.yml` + `.env.example`** — run `ada-server` anywhere:
  `docker compose up --build` → `http://localhost:8787`. Server-only image (`node:22-slim`, no native
  build), data persisted at a `/data` volume. Point clients with `ADA_BACKEND_URL` / `ada.backendUrl`.
- **[docs/deploy.md](docs/deploy.md)** — env, persistence, and Cloudflare hosting: use Workers AI
  models (`@cf/*`) or an AI Gateway with **zero code change**; container-first on Fly/Render/Railway
  now, with the edge-native Workers + D1/KV port outlined as the next phase.
- CI gains a build-only `docker` job so the image is verified on every push/PR.

### Changed
- **`node-pty` is now an optional dependency.** It's a client-only PTY nicety with an existing
  `spawnSync` fallback, so making it optional lets the server image build without a C toolchain **and**
  stops `npm i -g ada-agent` from failing on machines with no compiler (the CLI falls back cleanly).

## [0.8.0] — 2026-07-02

### Added — OIDC SSO + JIT seat provisioning (enterprise Stage 2)
Federate developer login to your OIDC IdP (Okta, Entra **single-tenant**, Auth0, Keycloak, Google
Workspace). Setting `ADA_OIDC_ISSUER` locks the backend and turns on SSO. See
[docs/enterprise-stage2-oidc.md](docs/enterprise-stage2-oidc.md).

- **Device-flow SSO** — `ada login oidc` runs the browser device flow against the IdP; the client
  self-configures from the backend's new unauthenticated `GET /v1/auth/methods` (no OIDC env on the
  client). The ID token is exchanged once at `POST /v1/auth/oidc/exchange` for a durable `ada_sk_`
  **seat key** (model B), which carries every later request — so `-p`/`serve`/`acp` never expire
  mid-run, and revocation is a seat-disable rather than a token-lifetime wait.
- **JIT provisioning** — a verified identity is provisioned a seat keyed to a stable, non-secret,
  issuer-scoped `externalId` (`iss#sub`). Reused seats aren't rotated; an admin login that drops the
  admin group downgrades the seat (never auto-escalates).
- **Immediate offboarding** — admin `POST /v1/users/disable-by-external { externalId }`; a disabled
  seat 401s on the next request and re-login is refused (no resurrection).
- **Stdlib-only verification** — RS256 + JWKS via `node:crypto`, **zero new dependencies**.

### Security (fail-closed by construction)
- `ADA_OIDC_ISSUER` adds to `locked()` so a fresh SSO deployment with **zero seats** never falls to
  dev-open. The server **refuses to start** without a positive allow-surface
  (`ADA_OIDC_ALLOWED_GROUPS`/`ADA_OIDC_ALLOWED_DOMAINS`) or with a **multi-tenant** issuer.
- `alg` allowlisted to RS256 (rejects `none`/`HS*`); `iss`/`aud`/`azp`/`exp`/`nbf` checked; JWKS
  fetch rate-capped; `jwks_uri` https-only and blocked from loopback/private hosts (classified via
  `net.isIP`, so bracketed IPv6 literals can't slip through). Domain provisioning requires a
  **verified** email. The `id_token` is accepted at exactly one endpoint and never reaches the
  per-request identity path. GitHub/Google login **and** legacy `ADA_CLIENT_KEYS` are refused while
  OIDC is on (single identity authority).

Adversarially reviewed before release (5 finders → per-finding refutation → adjudication): 2 blockers
(legacy-shared-key SSO bypass, unverified-email provisioning), 1 major (bracketed-IPv6 SSRF-guard
bypass), and 2 minors — all fixed and regression-tested in selfcheck.

Design chosen and hardened via a multi-agent panel + 3-lens adversarial red-team (5 blockers, all
resolved before build). Live-verified: OIDC-locked backend 401s a tokenless request; fail-closed
startup on missing allow-surface and multi-tenant issuer; real-Google discovery + JWKS guard; exchange
rejects a bogus token.

## [0.7.0] — 2026-07-02

### Added — enterprise control plane (Stage 1)
`ada-server` now doubles as an org control plane. **Enterprise mode activates only when a seat
exists or `ADA_ADMIN_KEY` is set** — with neither, nothing changes. See
[docs/enterprise.md](docs/enterprise.md).

- **Seats** — per-user client keys (`POST/GET/DELETE /v1/users`, admin-gated; keys shown once,
  listed only as prefixes; disable keeps the audit trail). `ADA_ADMIN_KEY` bootstraps the first
  admin. `/v1/whoami` now reports `{user, role}`.
- **Org policy** (`GET/PUT /v1/policy`) — a model allowlist enforced **server-side** (403 + audit),
  and tool permission rules **pushed to clients**, merged restrictive-wins with local config (org
  deny beats local allow; org can tighten, never loosen). Applied in every client path:
  interactive, `-p` headless, `serve`, `acp`.
- **Usage metering** (`GET /v1/usage?days=N`) — per-user/per-model token counts captured
  server-side by teeing each chat response and recording the upstream's reported usage (works for
  streamed and non-streamed, all adapters, one code path).
- **Audit log** (`GET /v1/audit`) — seat lifecycle, policy updates, policy denials.
- File-backed under `~/.ada/server` (`ADA_DATA_DIR` to move) — a database is the upgrade path.

Live-verified end-to-end: bootstrap → seat create → 401/403 gating → model-allowlist denial
(audited) → allowed chat metered per user → org `web_* deny` blocking a tool inside a headless run.

## [0.6.1] — 2026-07-02

### Fixed
- **Windows: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" noise on exit.** Two causes,
  both fixed: the backend health probe's undici (fetch) keep-alive socket lingered into process
  teardown — the probe now uses plain `node:http` with `agent: false` (socket closes with the
  response; verified deterministic: 3× asserting before, 0× after, on both the probe-only and the
  autostart-spawn paths); and node-pty's native module was loaded at import time by every command —
  it now loads lazily on the first `bash` call, so `--version`, `catalog`, `--list-models`, etc.
  never touch it.

[0.6.1]: https://github.com/black141312/ada/releases/tag/v0.6.1

## [0.6.0] — 2026-07-02

### Added
- **`codebase_search` — @codebase semantic search.** A read-only tool that finds code by what it
  *does*, not by exact strings ("where do we handle auth?"). Chunks the working tree (80-line
  windows, char-capped for minified files), embeds through the backend's new `/v1/embeddings`
  (forwarded to Ollama — `ollama pull nomic-embed-text`, or set `ADA_EMBED_MODEL`), caches vectors
  in `.ada/index.json` keyed by content hash (incremental — only changed files re-embed; the cache
  key includes the embedding scheme so a model/prefix change rebuilds), and ranks by cosine.
  nomic models get the asymmetric `search_query:`/`search_document:` prefixes, which measurably
  improved code-vs-prose ranking in live tests. Backend `/v1/embeddings` endpoint by @black141312.

[0.6.0]: https://github.com/black141312/ada/releases/tag/v0.6.0

## [0.5.0] — 2026-07-02

The "do it all" gap batch — everything flagged as missing after 0.4.0.

### Added
- **`ada --version` / `-v`** — prints the version and exits. (Previously it fell through to
  interactive mode and even auto-started the backend.)
- **Session API completions** for IDE panels:
  - `POST /v1/sessions/:id/abort` — the "stop generating" button; also denies any approval the turn
    was parked on so it can't stay stuck.
  - **Busy guard** — a second `prompt` on a session with a turn running gets `409` instead of
    silently interleaving two turns into one conversation.
  - `PATCH /v1/sessions/:id {"mode":"ask"|"plan"|"auto"}` — switch the permission mode live.
  - `POST /v1/sessions/:id/steer` — queue a mid-turn user message (parity with the CLI's
    type-while-running steering).
  - `images` on `prompt` — attach data:/https: image URLs to a message.
  - SDK: `session.abort()`, `.steer()`, `.setMode()`, `prompt(…, { images })`.
- **Copilot token exchange** — set `COPILOT_GITHUB_TOKEN` and the backend exchanges it at
  `/copilot_internal/v2/token`, caching + refreshing the bearer (still needs a Copilot subscription
  to exercise; `COPILOT_API_KEY` continues to work as a direct bearer). Editor-identification
  headers now report the real ada version.
- **ACP bridge streaming** — `ada acp` now emits `session/update` notifications
  (`agent_message_chunk`, `tool_call`/`tool_call_update`) while a turn runs, matching the shape ACP
  editors render live. Still experimental until exercised against a real ACP client.
- **Windows CI job** — typecheck + selfcheck now also run on `windows-latest`, exercising the
  node-pty native build on the platform many users actually run.
- **Monthly catalog refresh** — a scheduled workflow re-snapshots the models.dev catalog and opens a
  PR when prices/models changed. (Needs the "Allow GitHub Actions to create and approve pull
  requests" repo setting.)

### Fixed
- **Skill auto-apply false positives** — a long conversational sentence merely *containing* a
  skill-y keyword ("remember this: the secret word is…" → `secret-scan`, observed live) no longer
  auto-applies. New coverage gate: at least a third of the query's content tokens must match the
  skill; short task-like commands ("describe the project") still fire.

### Security
- SECURITY.md now states plainly that `ada serve` has no auth of its own — keep it on localhost or
  front it with an authenticating proxy.

### Hardening (from a pre-merge adversarial review of this batch; all verified live)
- A client that dies **mid-request-body** (e.g. a dropped image upload) no longer bricks the session
  with a permanent 409 — the claim is released on `req` close.
- A client that **drops the SSE stream mid-turn** (IDE reload/crash) no longer leaves the turn
  running headless (or, in ask mode, parked forever on an approval nobody can see) — the turn is
  aborted on `res` close.
- The skill-router coverage gate counts **exact** token matches with a **strict** threshold — the
  prefix-matching + inclusive-bound combination re-admitted short phrasings of the very leak the
  gate was built to stop.
- Copilot: `COPILOT_GITHUB_TOKEN` alone now actually configures the provider (the exchange was
  unreachable), stored credentials again send an auth header, and an upstream 401 invalidates the
  cached bearer.
- Resuming a transcript that a live session is still writing is refused (409 + the live sessionId)
  instead of interleaving two conversations into one file.
- `tool_call`/`tool_result` events carry a stable `callId` (generated when a backend omits streamed
  ids); ACP gained `session/cancel`; SDK `abort()` surfaces HTTP errors instead of pretending success.

[0.5.0]: https://github.com/black141312/ada/releases/tag/v0.5.0

## [0.4.0] — 2026-07-01

### Added
- **Interactive agent sessions on `ada serve`** — the integration point for building a Cursor-style
  agent panel into your own IDE, from any language, over HTTP + Server-Sent Events:
  `POST /v1/sessions` → persistent session, `POST /v1/sessions/:id/prompt` → streamed
  `text`/`tool_call`/`tool_result`/`approval_request`/`done` events, `POST /v1/sessions/:id/approve`
  to answer a pending approval from your own UI, `DELETE /v1/sessions/:id` to free it. Sessions
  default to real approval gating (`autoApprove: false`) — edits pause until you decide, they never
  auto-run silently.
- `Agent.send()` gained an `onEvent` option (`AgentEvent`: text/tool_call/tool_result/done) — the
  structured alternative to writing ANSI text to stdout, additive and opt-in (existing CLI/TUI
  behavior is unchanged when it isn't set).
- The typed SDK (`src/sdk`) gained `ada.session()` — a small wrapper around the above (manual SSE
  parsing, no dependency) with `.prompt(text, onEvent)`, `.approve(id, decision)`, `.close()`.
- `src/client/agent-server.ts` — the pure, unit-tested helpers behind the session endpoints
  (SSE framing, id generation, approval correlation).
- **Session resume across an `ada serve` restart.** `GET /v1/sessions` lists on-disk transcripts;
  `POST /v1/sessions` accepts `{ resume: "latest" | "<file>" }` to reattach a fresh in-memory Agent
  to an existing one, replaying its history so the conversation continues where it left off even
  after the server process died and restarted. SDK: `ada.listSessions()`, `ada.session({ resume })`.

Verified live end-to-end against a local Ollama model: session create → tool_call →
approval_request → approve → tool_result → done, with the file actually written only after approval.
Resume verified by killing and restarting the `ada serve` process mid-conversation (a fresh,
empty in-memory session map) and confirming the model still recalled a fact from before the restart.

[0.4.0]: https://github.com/black141312/ada/releases/tag/v0.4.0

## [0.3.1] — 2026-06-30

### Fixed
- `npx ada-agent` failed with "could not determine executable to run" — the package has two bins
  (`ada`, `ada-server`) and neither matched the package name after the rename. Added an `ada-agent`
  bin alias (→ the client) so `npx ada-agent` and `npm i -g ada-agent && ada-agent` work as documented.

[0.3.1]: https://github.com/black141312/ada/releases/tag/v0.3.1

## [0.3.0] — 2026-06-30

### Added
- **Auto-start the backend** — `ada` now spawns `ada-server` as a child process if it isn't already
  reachable. Solo users no longer need two terminals. `ADA_BACKEND_URL` pointing at a remote URL
  skips the auto-start; `ADA_NO_AUTOSTART=1` opts out. Backend-free subcommands
  (`mcp`/`skill`/`worktree`/`catalog`/`share`) don't trigger it either.
- **`.github/workflows/release.yml`** — auto-publish `ada-agent` to npm on a `v*` tag push, with a
  tag-vs-`package.json` safety check + provenance attestation. The CONTRIBUTING release flow is
  documented.

[0.3.0]: https://github.com/black141312/ada/releases/tag/v0.3.0

## [0.2.0] — 2026-06-30

### Added
- **Cloudflare** provider (Workers AI + AI Gateway, OpenAI-compatible) — env-overridable URL covers
  both endpoints. New `@cf/*` router rule. `@cf/moonshotai/kimi-k2.7-code` is now runnable.
- **`groq/<model>`** and **`together/<model>`** routing prefixes — disambiguate shared model names
  (`llama-3.3`, `gemma2`) that no prefix can.
- **Curated offline model catalog** snapshotted from models.dev (12 providers, 672 models) — baked
  `src/client/catalog.json`, used as the offline seed for pricing/limits. Maintained via
  `npm run catalog:refresh`. New `ada catalog [provider]` subcommand + `/catalog` REPL command.
- **`bench/swebench.mjs`** — SWE-bench Verified prediction generator driven by ada (resumable,
  concurrent, isolated repo clones); scoring stays with the official `swebench` Docker harness.
- **`docs/cloudflare.md`** — Workers AI + AI Gateway step-by-step.

### Changed
- npm package renamed to unscoped **`ada-agent`** (`npx ada-agent`, `npm i -g ada-agent`); the CLI
  command stays `ada`. (`ada` / `ada-code` were taken/blocked on npm.)
- Generalized the OpenAI-compat adapter's model-prefix strip (handles `copilot/` / `groq/` /
  `together/`); `@cf/…` passes through as-is.
- Architecture diagram refreshed (richer client card, full provider list); docs refreshed
  (architecture / integrations / connectors).

[0.2.0]: https://github.com/black141312/ada/releases/tag/v0.2.0

## [0.1.0] — 2026-06-30

First public release. ada is a from-zero terminal coding agent: a key-holding **routing backend**
(OpenAI Chat Completions in, every provider out) plus a thin **terminal client** — run through `tsx`,
no build step.

### Core
- Agentic loop with streaming, parallel read-only tools, and leaked-tool-call recovery for weaker models.
- Providers: OpenAI, Anthropic, Google Gemini, Mistral, Groq, DeepSeek, Together, xAI, DashScope,
  OpenRouter, and local Ollama — routed by model id; a new OpenAI-compatible provider is two lines.
- Tools: `read_file`, `write_file`, `edit_file`, `apply_patch` (multi-file), `bash` (real PTY via
  node-pty), `ls`, `glob`, `grep` (ripgrep fast-path), `web_fetch`/`web_search` (SSRF-guarded),
  `lsp_diagnostics`, `ask_user`, `spawn_agent`, `background_task`.
- Sessions (persisted, `--continue`/`--resume`), automatic context compaction, checkpoint/undo,
  git worktrees, workspace snapshots (`/snapshot` `/restore`), named agents.

### Skills & orchestration
- ~285 built-in skills with progressive disclosure (`list_skills`/`find_skill`/`use_skill`) and a
  relevance router that **auto-applies** a clearly-matching skill (precision-guarded against lexical
  false positives).
- Pluggable orchestration strategies: `react`, `single`, `plan`, `multi`, `toolsmith`.

### Connectors & integrations
- MCP connectors over stdio and Streamable HTTP, a curated catalog + `ada mcp` CLI, and resources.
- HTTP API (`ada serve`), a typed SDK (`src/sdk`), an ACP bridge (`ada acp`), and local session
  sharing (`ada share`). models.dev pricing/limits; a GitHub Copilot provider scaffold.

### Experience
- Permission modes — `/ask`, `/plan`, `/auto` (`/mode` to cycle), with plain-words approval prompts.
- Auto-format on edit (trusted projects), readline REPL and an inline TUI (`--tui`), GitHub/Google
  device-flow login, extensions (tools + hooks + commands), and prompt templates.

[0.1.0]: https://github.com/black141312/ada/releases/tag/v0.1.0
