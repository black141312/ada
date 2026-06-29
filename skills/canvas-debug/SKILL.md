---
name: canvas-debug
description: Debug HTML5 canvas rendering bugs: missing draws, smearing, wrong coordinates, broken transforms or clipping
category: graphics
---

# Canvas Debug

Reach for this when a 2D `<canvas>` shows nothing, smears frames together, draws in the wrong place, or scales oddly.

1. Confirm you have a 2D context and a sized canvas: log `ctx`, `canvas.width`, `canvas.height`. A canvas styled with CSS but never given `width`/`height` attributes defaults to 300x150 and stretches.
2. Reproduce in isolation: comment out the render loop and draw one hard-coded `fillRect(10,10,50,50)` in a solid color. If that shows, the bug is in your draw data/order, not the canvas.
3. For smearing/ghosting across frames, confirm you `clearRect(0,0,canvas.width,canvas.height)` (or reset) at the top of every frame; accumulating trails means the clear is missing or sized wrong.
4. For "everything shifted/rotated/gone after one draw", audit `save()`/`restore()` pairing — an unmatched `translate`/`rotate`/`scale` leaks into later draws. Add a counter or wrap each entity's draw in `save()`...`restore()`.
5. For wrong coordinates on click/hit-test, map pointer coords through `getBoundingClientRect()` and the DPR scale, not raw `clientX/Y`; mismatched canvas pixel size vs CSS size is the usual culprit.
6. For invisible draws, check `globalAlpha`, `fillStyle`/`strokeStyle` (transparent or same-as-background), `lineWidth` 0, paths not `beginPath()`-reset between shapes, and drawing outside an active `clip()` region.

## Rules
- Set `canvas.width`/`canvas.height` as attributes (or in JS), never only via CSS — CSS only stretches the bitmap.
- Every `save()` needs exactly one `restore()`; never rely on resetting transforms by hand.
- Call `beginPath()` before each new shape or strokes/fills bleed into prior subpaths.
- Coordinates are in the transformed space — pointer hit-testing must invert the same transform.
- Clear the frame explicitly; canvases never auto-clear between draws.
