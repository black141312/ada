---
name: empty-states
description: Design empty, loading, and error states that orient the user and offer a clear next action.
category: ui-design
---

# Empty States

Reach for this whenever a view can have no data, be loading, or fail — these states are most of the real experience and deserve the same care as the happy path.

1. Distinguish the three cases and design each: first-run empty (no data yet), cleared empty (filters/search returned nothing), and error (something broke) — they need different copy and actions.
2. For first-run, make it a launchpad: a short encouraging line, a focused illustration or icon, and one primary CTA that creates the first item — turn the void into onboarding.
3. For "no results", explain why and give an out: echo the active query/filters and offer "clear filters" or a broader suggestion, not a generic shrug.
4. For errors, be specific and recoverable: plain-language cause, a "Try again" action, and a path to support — never expose a raw stack trace or a bare "Something went wrong".
5. Match the layout to the eventual content so the page doesn't jump when data arrives, and keep tone consistent with the product's voice (helpful, not cute-at-the-user's-expense).
6. Respect hierarchy and restraint: one illustration, one heading, one action; muted supporting text; accessible contrast and a real `role`/announcement for error states.

## Rules
- Every empty/error state offers at least one obvious next step — a dead end with no action is a bug.
- Error copy names what happened and what to do; "Oops!" with no recovery path is failure theater.
- Don't reuse the first-run empty state for "no search results" — they imply different user situations.
- Keep illustrations subtle and on-brand; they support the message, they aren't the message.
- Announce errors to assistive tech (`aria-live="assertive"` / `role="alert"`) and keep focus recoverable.
