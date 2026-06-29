---
name: dpi-scaling
description: Fix retina/HiDPI blur and layout — devicePixelRatio mismatch between canvas backing store and CSS size
category: graphics
---

# DPI Scaling

Reach for this when a canvas, chart, or rendered surface looks blurry or soft on retina/HiDPI displays but sharp on standard ones.

1. Confirm the symptom is DPR-related: read `window.devicePixelRatio`. If it's >1 and the canvas looks fuzzy, the backing store is smaller than the displayed pixels and the browser is upscaling.
2. Inspect the two sizes that must differ: CSS size (`canvas.style.width`/`getBoundingClientRect().width`, in CSS px) and backing-store size (`canvas.width`, in device px). The blur appears when `canvas.width === cssWidth` on a DPR-2 screen.
3. Fix the pattern: set `canvas.width = Math.round(cssWidth * dpr)` and `canvas.height = Math.round(cssHeight * dpr)`, keep `canvas.style.width/height` in CSS px, then `ctx.scale(dpr, dpr)` (2D) or `gl.viewport(0,0, canvas.width, canvas.height)` (WebGL) so your draw code stays in CSS units.
4. Re-run on a DPR change: listen for `matchMedia('(resolution: ...)')` or just recompute on `resize`; dragging a window between monitors changes DPR live.
5. Verify text/lines are crisp: a 1px line should hit a single device row — half-pixel offsets cause residual softness, so align strokes to `0.5` in 2D contexts after scaling.
6. Avoid double-scaling: don't both `ctx.scale(dpr)` and multiply coordinates by dpr — pick one (scale the context, draw in CSS px).

## Rules
- Backing store (`canvas.width`) must be CSS size times `devicePixelRatio`; the style width stays in CSS px.
- `ctx.scale(dpr,dpr)` once after sizing lets all draw code stay in logical units — don't also scale coordinates.
- Recompute on resize and on monitor change; `devicePixelRatio` is not constant.
- For WebGL, scale via `gl.viewport` and the drawing-buffer size, not by `ctx.scale`.
- Cap DPR (e.g. min(dpr,2)) for fill-rate-heavy scenes to avoid rendering 9x pixels on a 3x phone.
