---
name: gpu-profile
description: Profile GPU frame time and find the draw-call or fill-rate bottleneck behind dropped frames and jank
category: graphics
---

# GPU Profile

Reach for this when the frame rate drops or stutters and you need to find whether the GPU, the draw-call count, or the CPU submit is the bottleneck.

1. Measure first, don't guess: get a stable frame-time number (ms/frame, not just FPS) from the browser/engine profiler or a GPU timer query. One slow frame vs sustained slowness point to different causes.
2. Split CPU vs GPU: if CPU time per frame (JS/submit) already exceeds your budget, the GPU is starved — optimize the submit side. If CPU is cheap but frame time is high, you're GPU-bound; continue.
3. For GPU-bound, separate vertex/draw-call cost from fill-rate: shrink the canvas to a tiny size and re-measure. If it speeds up dramatically, you're fill-rate/overdraw bound (fragment shader, blending, big textures); if not, you're geometry/draw-call bound.
4. For draw-call bound, count draw calls per frame and batch: merge meshes, instance repeated geometry, atlas textures, and sort by material to cut state changes. Thousands of tiny draws is the classic cause.
5. For fill-rate bound, reduce overdraw (sort opaque front-to-back, cut large transparent layers), lower the heaviest fragment shader cost, shrink/compress textures, and cap devicePixelRatio.
6. Confirm the fix against the same frame-time metric under the same scene, and watch for a moved bottleneck (fixing fill-rate can expose a draw-call wall).

## Rules
- Profile in milliseconds per frame; FPS hides how close you are to the next dropped-frame threshold.
- The resize-the-canvas test is the fastest way to tell fill-rate from geometry bound — use it before optimizing.
- Draw-call count and state changes, not triangle count, are usually the wall on modern GPUs — batch and instance.
- Always disable browser/devtools overlays and run a release build when measuring; debug layers distort timings.
- Re-measure after each change; optimizing the non-bottleneck buys nothing and bottlenecks move.
