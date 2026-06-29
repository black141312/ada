---
name: texture-debug
description: Debug texture loading, UV mapping, mipmaps, wrapping and seams — black, blurry, repeated, or flipped textures
category: graphics
---

# Texture Debug

Reach for this when a textured surface shows black, solid color, blur, visible seams, repeats, or upside-down/mirrored image.

1. Confirm the image actually loaded before upload: textures uploaded from an unloaded `<img>`/fetch are blank. Log dimensions and bind from the `onload`/awaited decode, not synchronously.
2. Swap in a known-good debug texture (a 2x2 checker or magenta/green stripes generated in code). If the checker maps correctly, the bug is your asset or its load; if it's also wrong, the bug is UVs/sampling.
3. For black or solid-color textures in WebGL/GL, check the NPOT (non-power-of-two) rule: NPOT textures require `CLAMP_TO_EDGE` wrapping and `LINEAR`/`NEAREST` (no mipmap) min filter, or they sample black. Either pad to POT or set those params.
4. For blur/shimmer at distance or on minification, you likely have no mipmaps: call `generateMipmap` after upload and use a `*_MIPMAP_*` min filter. For oversharp/aliased edges at angles, enable anisotropic filtering if available.
5. For repeating or stretched-edge artifacts, audit wrap mode: `REPEAT` tiles, `CLAMP_TO_EDGE` smears the border, `MIRRORED_REPEAT` flips. Pick to match intent and check UVs aren't outside [0,1] unintentionally.
6. For flipped/mirrored images, check the Y convention (`UNPACK_FLIP_Y_WEBGL` or a flipped UV.y) and that your atlas/UV offsets use top-left vs bottom-left origin consistently.

## Rules
- Never bind a texture before its source image has finished decoding — upload in the load callback.
- NPOT textures + `REPEAT` or mipmap filtering = black sample; clamp + non-mip filter, or resize to POT.
- `generateMipmap` must run after the base level is uploaded and again on any base-level change.
- Set min and mag filters explicitly; defaults vary and the mipmap default needs mipmaps to exist.
- Seams between tiles usually mean `REPEAT` where you wanted `CLAMP_TO_EDGE`, or half-texel UV bleed — inset UVs by half a texel.
