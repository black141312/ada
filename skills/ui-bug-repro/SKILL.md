---
name: ui-bug-repro
description: Turn a screenshot or screen recording of a UI bug into a deterministic, scripted reproduction
category: visual-test
---

# UI Bug Repro

Reach for this when someone hands you a screenshot or recording of broken UI and you need to reproduce it reliably before you can fix it.

1. Extract the context from the artifact: read the visible URL/route, viewport dimensions (from image size + DPR), theme, locale, and any error text or console overlay.
2. Reconstruct the path: from a recording, step frame-by-frame to list the exact actions (clicks, inputs, scrolls, resizes) and the data state that triggered the bug.
3. Script those steps in the app's driver (browser automation / e2e runner) at the same viewport and DPR, seeding the same data, until you see the bug live.
4. Capture your reproduced screenshot and overlay/diff it against the reported one to confirm you've hit the *same* failure, not a lookalike.
5. Bisect the trigger: remove steps and vary one input (viewport, data length, font, async timing) to find the minimal condition that produces it.
6. Commit the repro as a failing test, then fix and watch it go green.

## Rules
- The viewport, DPR, and theme are often the whole bug; derive them from the image (pixel dimensions ÷ DPR) before guessing.
- Reproduce with the reporter's *data shape* (long strings, empty states, RTL, huge numbers) — most "only on my screen" UI bugs are data-driven.
- Race conditions and animation-timing bugs need controlled async (fake timers, throttled network) to reproduce on demand.
- Confirm the repro by diffing against the original artifact; "looks similar" is how you fix the wrong bug.
- Land the failing repro test first — a UI bug without a reproducing test regresses within a sprint.
