---
name: alpha-compositing
description: Fix alpha blending, transparency, and premultiplied-alpha bugs — dark/white halos, wrong order, additive glow
category: graphics
---

# Alpha Compositing

Reach for this when transparent images show dark or white fringes, edges glow, layers stack wrong, or "transparent" pixels aren't.

1. Reproduce on a stark background: composite the asset over pure red AND pure white. Dark halos on light backgrounds (or bright fringes on dark) are the classic premultiplied-vs-straight-alpha mismatch.
2. Decide one alpha convention end-to-end. If the source is premultiplied, the blend func must be `ONE, ONE_MINUS_SRC_ALPHA`; if straight, `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. Mixing the upload flag and the blend func is the #1 cause of halos.
3. Check the upload/decode flag: in WebGL toggle `UNPACK_PREMULTIPLY_ALPHA_WEBGL`; in canvas/CSS the browser premultiplies. Verify whether your PNG was authored premultiplied and align the flag to it.
4. For correct blending of semi-transparent geometry, draw back-to-front and disable depth writes (keep depth test) for the transparent pass — out-of-order alpha produces hard wrong edges where far fragments overwrite near ones.
5. For unexpected additive "glow", confirm you didn't leave an additive blend (`ONE, ONE`) set from a particle/bloom pass; blend state is sticky across draws.
6. Confirm the texture even has an alpha channel and an internal format that keeps it (`RGBA`, not `RGB`); a dropped alpha makes everything opaque.

## Rules
- Pick premultiplied OR straight alpha and keep the upload flag and blend function consistent — never mix.
- Dark fringes on light bg = treating premultiplied data as straight (or vice versa); test on red+white to confirm.
- Transparent geometry: sort back-to-front, depth-test on, depth-write OFF.
- Blend mode is global state; reset it after additive/special passes or it leaks.
- "Transparent" needs an actual alpha channel AND a blend enabled — `RGB` format or `disable(BLEND)` makes alpha a no-op.
