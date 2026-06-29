---
name: screenshot-debug
description: Drive the app to the broken state, capture screenshots, and inspect a visual bug down to the offending element
category: visual-test
---

# Screenshot Debug

Reach for this when a UI looks wrong ("button overlaps text", "modal off-screen") and you need eyes on the actual render, not the code you imagine it produces.

1. Reproduce the exact state: script the navigation (URL, clicks, form fills, viewport size) that leads to the bug so every capture is identical. Pin viewport and device-pixel-ratio.
2. Capture full-page AND a tight element crop (`page.locator(sel).screenshot()`); the crop removes surrounding noise and shows sub-pixel issues.
3. Dump the computed state next to the image: `getComputedStyle`, `getBoundingClientRect`, and the DOM subtree HTML — the screenshot shows *what*, these show *why*.
4. Toggle one variable at a time (resize viewport, force `:hover`/`:focus`, disable a CSS rule via devtools protocol) and re-shoot to bisect the cause.
5. Confirm the fix by re-running the same script and comparing the new screenshot to the broken one in the same dimensions.

## Rules
- Wait for the network/animations to settle before shooting (`waitForLoadState('networkidle')`, disable CSS transitions) or you capture a transient frame and chase a ghost.
- Always record the viewport size, DPR, and theme (light/dark) in the filename; "looks fine for me" is usually a different viewport.
- Screenshot the element, not just the page — a 1px misalignment is invisible at full-page scale.
- Disable animations and freeze time/`Date.now` for deterministic frames before comparing shots.
- Keep the repro script in the repo; a bug you can't re-capture on command isn't fixed, it's hidden.
