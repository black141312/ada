---
name: image-decode
description: Debug image decode/encode failures — wrong format, corruption, bit depth, ICC profile, truncated files
category: image
---

# Image Decode

Reach for this when an image fails to load, decodes to garbage/partial, or comes out with wrong colors/depth after a round-trip.

1. Reproduce and capture the exact error or symptom (exception, truncated render, color shift). Save the raw bytes so you can inspect them independent of your code.
2. Verify the actual format vs the claimed one: check magic bytes / `file`, not the extension. A `.png` that's really a JPEG (or HTML error page) is a classic decode failure.
3. Check for truncation/corruption: compare on-disk size to the header's expected size, try decoding with a strict decoder, and re-download/re-export the source if the tail is missing. Enable `ImageFile.LOAD_TRUNCATED_IMAGES` only to confirm truncation, not as a fix.
4. Inspect bit depth and channel count: 8 vs 16-bit, palette (indexed) vs RGB, grayscale vs RGBA. A stage assuming uint8 on a 16-bit PNG, or RGB on an indexed/CMYK image, decodes to wrong values.
5. Check ICC color profiles: CMYK JPEGs and wide-gamut PNGs with an embedded profile render wrong if the profile is dropped or not converted to sRGB. Convert explicitly rather than discarding the profile silently.
6. Test the encode side by round-tripping: decode → re-encode → decode and diff. Lossy re-encoding (JPEG), wrong quality/subsampling, or dropping alpha shows up here.
7. Lock the fix by decoding into an explicit mode/bit-depth and asserting shape, dtype, and channel count.

## Rules
- Trust magic bytes over file extensions and over the server's Content-Type.
- CMYK and indexed/palette images are the silent killers — convert to a known mode right after decode.
- Preserve or explicitly convert ICC profiles; silently dropping one shifts colors without erroring.
- Distinguish "won't decode" (format/corruption) from "decodes wrong" (depth/profile/mode) before fixing.
- Re-encoding is often lossy — verify round-trips when the pipeline writes intermediates.
