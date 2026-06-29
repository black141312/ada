---
name: image-memory
description: Diagnose image memory blowups and leaks — huge decoded bitmaps, uncleared caches, retained handles
category: image
---

# Image Memory

Reach for this when an image workload's RSS balloons or grows unbounded over time, risking OOM, even though files on disk are small.

1. Reproduce and watch memory over a controlled run (process N images in a loop) with an RSS sampler or memory profiler; a steadily rising baseline means a leak, a single spike means one oversized decode.
2. Remember decoded size != file size: a 2 MB JPEG decodes to `width × height × channels` bytes (a 6000×4000 RGBA image is ~96 MB raw). Log decoded dimensions of the largest inputs — one giant image can dwarf the file size.
3. For leaks, find what retains buffers: unclosed image handles, appending decoded arrays to a list/cache that's never evicted, closures capturing big arrays, or thumbnails keeping the full-res parent alive.
4. Inspect caches: an unbounded LRU/dict keyed by URL or path that stores decoded bitmaps grows forever. Add a size cap (by bytes, not count) and confirm eviction actually frees memory.
5. Stream/downscale early: decode at a reduced size (JPEG DCT scaling, `draft`/thumbnail-on-decode) so you never materialize the full-res bitmap when you only need a small one.
6. Free deterministically: close/`del` large arrays as soon as you're done, avoid keeping the whole batch in memory, and process in chunks rather than loading everything.
7. Confirm the fix by re-running the loop and showing RSS is now flat (leak) or capped (blowup).

## Rules
- Reason in decoded pixels, not file bytes — that's where the memory actually goes.
- Always close/dispose image handles; rely on context managers, not the garbage collector.
- Caches of decoded images must be bounded by total bytes and must evict; verify freeing, don't assume it.
- Decode/downscale to the size you need; don't materialize full-res bitmaps for thumbnails.
- A flat RSS over a long loop is the only proof a leak is fixed.
