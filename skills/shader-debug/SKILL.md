---
name: shader-debug
description: Debug a GLSL/WGSL shader: black/garbage output, NaNs, wrong UVs, precision and uniform mismatches
category: graphics
---

# Shader Debug

Reach for this when geometry draws but the shading is wrong: solid black, blown-out white, banding, flicker, or NaN holes.

1. Reproduce with a constant: replace the fragment output with `gl_FragColor = vec4(1.0,0.0,1.0,1.0)` (or `return vec4(1,0,1,1)`). If magenta shows, the pixeling pipeline is fine and the bug is in your math/inputs.
2. Visualize inputs as color instead of guessing: output `vec4(uv, 0, 1)`, then `vec4(normal*0.5+0.5,1)`, then each uniform. Wrong gradients pinpoint bad UVs, un-normalized normals, or a uniform stuck at 0.
3. Hunt NaN/Inf: they propagate to black or weird pixels. Guard `pow`, `log`, `sqrt`, `normalize(vec3(0))`, and divides by length/dot that can hit zero. Add `if (isnan(x)) out = vec4(1,0,0,1);` to see where.
4. Check uniforms actually arrive: confirm the uniform location is valid (not -1), the value is set every frame after binding the program, and the CPU/GPU types match (a `float` sent to a `vec3`, or an int/float mismatch, silently misbehaves).
5. For mobile-only or GPU-specific breakage, add explicit `precision highp float;` and test — default `mediump` overflows on large coords/times, causing banding or jitter that desktop hides.
6. Confirm UV orientation: many pipelines flip V. If textures appear upside-down or mirrored, try `uv.y = 1.0 - uv.y` and fix at the source (texcoord upload or sampler), not per-shader hacks.

## Rules
- A uniform location of -1 means the name is wrong OR the compiler dead-stripped it because it's unused — verify it's actually referenced.
- `normalize` of a zero vector is NaN; guard any vector that can degenerate.
- Don't trust `mediump` for world-space positions or `time` — promote to `highp` and confirm the artifact moves.
- GLSL has no debugger; debug by writing intermediate values to the output color, one at a time.
- Match CPU and GPU types and component counts exactly — silent mismatches are the most common "looks fine but wrong" bug.
