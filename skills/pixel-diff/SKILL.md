---
name: pixel-diff
description: Diff two images and localize exactly which pixels, regions, and channels differ between them
category: visual-test
---

# Pixel Diff

Reach for this when you have two images that should match (expected vs actual, before vs after) and need to know precisely where and how much they differ.

1. Normalize first: confirm both images share dimensions, color space, and bit depth — resize/convert mismatches before diffing or every pixel "differs".
2. Run a per-pixel diff (`pixelmatch`, ImageMagick `compare -metric AE`, or Pillow `ImageChops.difference`) and emit a diff image that highlights changed pixels.
3. Read the metrics: total differing pixels, max per-pixel delta, and the bounding box of the changed region — this localizes the problem to a corner/widget.
4. If the whole image lights up, suspect a global cause: gamma/color-profile shift, anti-aliasing, DPR mismatch, or a 1px offset — not a content change.
5. Zoom the diff region and inspect channels separately (R/G/B/A); an alpha-only diff means transparency/compositing, a uniform RGB shift means color management.
6. Set an anti-aliasing-aware tolerance so AA fringes don't dominate the real signal.

## Rules
- Dimension/format mismatch is the #1 false positive — always assert equal size and color space before comparing.
- A diff that's a faint copy of the whole image is almost always a 1px shift or AA difference, not a content bug.
- Output a *highlighted* diff image, not just a number; "1.2% pixels differ" tells you nothing about where.
- Watch alpha: many tools diff RGB only and miss transparency bugs — diff all four channels.
- Use a perceptual/AA-aware threshold for screenshots; use exact (AE=0) only for synthetic, pixel-perfect images.
