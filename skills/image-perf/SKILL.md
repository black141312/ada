---
name: image-perf
description: Optimize image load/decode/processing throughput — find the bottleneck before changing code
category: image
---

# Image Perf

Reach for this when image loading, decoding, or processing is too slow and you need to raise throughput without guessing.

1. Reproduce on a representative batch and measure end-to-end time plus a per-stage breakdown (download vs decode vs resize vs model/encode). Optimize the dominant stage — never the one you assume.
2. Determine if you're I/O-bound or CPU-bound: high wait/low CPU means I/O (network/disk), saturated cores means decode/compute. The diagnosis dictates the fix (concurrency vs faster codec/SIMD vs fewer pixels).
3. Decode at target size, not full res: use JPEG scaled decoding / draft mode / thumbnail-on-load so you never decode pixels you'll immediately throw away — often the single biggest win.
4. Parallelize the right way: overlap I/O with threads/async (GIL released during native decode), and use processes for CPU-heavy pure-Python work. Batch GPU/model calls instead of one-at-a-time.
5. Swap in faster building blocks where it matters: a SIMD/turbo JPEG decoder, a vectorized resize, or GPU decode/resize; pick the right interpolation (don't pay for bicubic when bilinear suffices).
6. Cache and avoid rework: memoize decoded/resized results, reuse buffers instead of reallocating per image, and skip redundant color conversions or copies between stages.
7. Re-measure after each change and keep only the ones that move the dominant stage; verify output is still correct (perf must not silently change pixels).

## Rules
- Profile first and per-stage — the bottleneck is rarely where intuition says.
- Decoding fewer pixels (scaled decode/downsample-on-load) usually beats any post-decode optimization.
- Classify I/O-bound vs CPU-bound before choosing threads, processes, or a faster codec.
- Threads overlap native decode (GIL released); use processes only for CPU-bound pure-Python.
- Verify pixels are unchanged after optimizing; faster but wrong is a regression.
