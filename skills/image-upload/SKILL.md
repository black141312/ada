---
name: image-upload
description: Debug an image upload pipeline end to end — mime sniffing, EXIF strip, orientation, resize, size limits, storage
category: visual-test
---

# Image Upload

Reach for this when uploads fail, get rejected, come out rotated, or land corrupted in storage. Debug the pipeline stage by stage, not all at once.

1. Capture the raw bytes the server actually received (log to a temp file before any processing) — most "corrupt image" bugs are a truncated or wrongly-encoded multipart body.
2. Verify type by content, not extension: sniff the magic bytes (`file`, libmagic) and reject on the sniffed mime; a `.png` that's really a polyglot/SVG is a security bug.
3. Check orientation: read the EXIF `Orientation` tag — if you strip EXIF without baking rotation into pixels first, portrait photos render sideways.
4. Strip metadata after applying orientation: remove EXIF/GPS/ICC (or transcode) so you don't leak location and don't ship surprise color profiles.
5. Enforce limits in order — byte size, then decoded dimensions (the decompression-bomb guard), then re-encode to a safe format at a capped resolution.
6. Confirm the stored object: re-download it, check mime/dimensions/byte size, and render it to verify the round trip, not just the HTTP 200.

## Rules
- Never trust the client filename or `Content-Type`; sniff magic bytes server-side and decide from that.
- Apply EXIF orientation to pixels BEFORE stripping metadata, or rotated images become permanently sideways.
- Guard decoded dimensions, not just file size — a 2KB PNG can decode to gigapixels (decompression bomb / OOM).
- Strip GPS/EXIF for privacy and re-encode through a trusted decoder to neutralize embedded payloads.
- Verify by reading the object back from storage and rendering it; a 200 response doesn't prove the bytes are intact.
- Test the ugly cases: HEIC, CMYK JPEG, animated GIF/WebP, SVG, and zero-byte uploads each break a different stage.
