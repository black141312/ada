---
name: image-pipeline
description: Debug an image-processing pipeline where resize/crop/filter order or off-by-one errors corrupt output
category: image
---

# Image Pipeline

Reach for this when an image pipeline produces shifted, cropped-wrong, blurred, or subtly-off output and you suspect operation ordering or boundary math.

1. Reproduce with one fixed input image and dump the intermediate after EVERY stage (write `stage_01.png`, `stage_02.png`, ...) so you can see exactly where it breaks.
2. Make a synthetic test image with known features — a 1px grid, a colored corner marker, a centered crosshair — so any shift, flip, or crop is obvious by eye and by pixel coordinate.
3. Check operation ORDER: resize-then-crop vs crop-then-resize give different results; sharpen/blur before vs after downscale changes aliasing. Confirm the order matches the spec, not just "looks plausible".
4. Audit boundary math: half-open vs closed ranges (`[x0, x1)` vs `[x0, x1]`), center computed as `w/2` vs `(w-1)/2`, and whether crop boxes are inclusive. Off-by-one usually shows as a 1px black/duplicated edge row or column.
5. Verify interpolation and rounding: integer truncation vs round, and whether coordinates are floored before sampling. Switch to nearest-neighbor temporarily to expose pure positional errors without resampling blur.
6. Bisect by short-circuiting stages to identity (pass-through) one at a time until the output goes correct; the last stage you disabled owns the bug.
7. After the fix, assert pixel-exact equality (or SSIM above threshold) against a golden image so the regression is locked.

## Rules
- Always inspect intermediates as files; never trust "the array shape looks right".
- Resize changes coordinates — any crop/box/coordinate computed before a resize must be rescaled, not reused.
- A 1px dark border or doubled edge line almost always means an inclusive/exclusive range mismatch.
- Keep a deterministic synthetic fixture in the repo; floating photos make off-by-one invisible.
- Watch for silent dimension swaps: `(w, h)` vs `(h, w)` between libraries flips the whole image without erroring.
