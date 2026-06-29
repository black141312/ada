---
name: opencv-debug
description: Debug OpenCV pipelines — dtype mismatch, BGR channel order, ROI/bounds errors, in-place op surprises
category: image
---

# OpenCV Debug

Reach for this when an OpenCV (`cv2`) pipeline throws on a function, returns black/empty arrays, or produces wrong colors or crops.

1. Reproduce and at the failing line print `img.shape`, `img.dtype`, and `img.min()/max()` — most cv2 bugs are a wrong dtype or unexpected channel count, and these three lines reveal it.
2. Confirm channel order: `cv2.imread` returns BGR. If you mixed it with PIL/matplotlib/Torch (RGB), colors swap. Convert explicitly with `cv2.cvtColor(img, cv2.COLOR_BGR2RGB)` at the boundary, not ad hoc.
3. Check dtype expectations: many ops need `uint8` (0–255) or `float32` (0–1); passing float images where uint8 is expected (or vice versa) gives black output or assertion errors. Cast deliberately, never rely on implicit promotion.
4. Audit ROI and slicing: numpy slices are `img[y0:y1, x0:x1]` (row=y first), but most cv2 point/rect APIs take `(x, y)`. Swapping these crops the wrong region or throws on out-of-bounds. Clamp coordinates to `[0, w)` / `[0, h)`.
5. Watch in-place / shared-buffer ops: a slice is a VIEW, and functions like `cv2.rectangle` mutate in place. Unexpected modifications to "another" image mean you aliased a buffer — `.copy()` to isolate.
6. Validate empty/None returns: `imread` returns `None` for a missing/unreadable path (no exception). Check for `None` before the next op, which otherwise fails cryptically.
7. Visualize the intermediate (`cv2.imwrite`) at the suspect stage to confirm geometry and color before continuing.

## Rules
- numpy indexing is `[row=y, col=x]`; cv2 geometry APIs are `(x, y)` — the swap causes most ROI bugs.
- `cv2.imread` is BGR and returns `None` (not an error) on failure; handle both explicitly.
- Know each op's required dtype/range; float vs uint8 mismatches silently yield black images.
- Slices are views and many cv2 calls mutate in place — `.copy()` when you need an independent buffer.
- Print `shape`, `dtype`, `min/max` at the failure point before theorizing.
