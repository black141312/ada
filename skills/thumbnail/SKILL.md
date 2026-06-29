---
name: thumbnail
description: Generate and debug thumbnails and responsive srcset — aspect ratio, sharpness, format, and the picked source
category: visual-test
---

# Thumbnail

Reach for this when thumbnails come out stretched, blurry, wrong-format, or the browser picks the wrong `srcset` candidate.

1. Reproduce against the actual source asset: pull the original, note its real dimensions and aspect ratio, and run the resize step in isolation.
2. Diagnose distortion: stretched output means the resize ignored aspect ratio — decide fit (`cover` crop vs `contain` letterbox) explicitly and apply it.
3. Diagnose blur: re-encoding at low quality, upscaling a small source, or a bad downscale filter — downscale with a quality filter (Lanczos/area) and never upscale past the source.
4. Pick the format deliberately: serve AVIF/WebP with a JPEG/PNG fallback; debug `<picture>`/`type` negotiation by checking which candidate the browser actually requested.
5. Build the `srcset` with real intrinsic widths and a correct `sizes` attribute, then verify in devtools (Network → the chosen file, `currentSrc`) that the expected candidate loads at each DPR/viewport.
6. Confirm visually: render each generated size at its display box and diff against the source crop to catch off-by-one cropping or wrong gravity.

## Rules
- Decide and document fit mode (cover vs contain) per use case — silent stretching is the most common thumbnail bug.
- Never upscale beyond the source resolution; generate only sizes ≤ original and let CSS handle the rest.
- `sizes` is required for `srcset` width descriptors to work — a missing/wrong `sizes` makes the browser fetch the largest candidate every time.
- Use a proper downscaling filter and a sane quality setting; default/fast filters produce mushy thumbnails.
- Verify the *picked* source via `img.currentSrc` and the Network tab, not by guessing from the markup.
- Generate at device pixel ratios (1x/2x/3x) and cache by content hash so a re-upload busts stale thumbnails.
