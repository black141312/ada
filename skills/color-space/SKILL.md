---
name: color-space
description: Fix color-space and channel-order bugs — RGB vs BGR, gamma, premultiplied alpha, wrong colors
category: image
---

# Color Space

Reach for this when colors look wrong — red and blue swapped, washed out, too dark/bright, or halos around transparent edges.

1. Reproduce by saving the suspect image and opening it in a viewer you trust; describe the exact symptom (R/B swap looks like blue skin/orange sky; gamma looks like uniformly too-dark or too-light).
2. For swapped colors, test the channel-order hypothesis directly: reverse channels (`img[..., ::-1]`) once and see if it corrects. OpenCV loads BGR while PIL/most libs use RGB — conversions at every library boundary are the usual culprit.
3. For brightness/contrast that's "off", suspect gamma: check whether values are linear or sRGB-encoded, and whether a stage assumed the wrong one. Linear math (blending, resizing) on sRGB-encoded data darkens; double gamma washes out.
4. For edge halos or dark fringes on transparency, check premultiplied vs straight (non-premultiplied) alpha. Compositing straight alpha as if premultiplied (or vice versa) produces fringing — verify what the encoder/decoder expects.
5. Isolate the offending stage by feeding a known swatch (pure red `(255,0,0)`, 50% gray, a half-transparent pixel) through the pipeline and reading the output values numerically, not visually.
6. Check normalization range mismatches: `0–255` uint8 vs `0–1` float vs `0–65535` uint16 — a stage dividing or not dividing by 255 shifts everything.
7. Fix at the correct boundary (convert once, explicitly) and add an assertion on a swatch's output values.

## Rules
- Name the color space at every boundary; "it's just an array" hides RGB/BGR and linear/sRGB confusion.
- Convert exactly once per boundary — double conversions cancel confusingly or compound.
- Premultiply/unpremultiply must pair with the alpha convention the next stage expects; never mix.
- Do gamma-correct (linear-light) math for resize/blend when accuracy matters; document where you decode/encode sRGB.
- Verify with numeric pixel values of known swatches, not just eyeballing — R/B swaps on grayscale-ish images are invisible.
