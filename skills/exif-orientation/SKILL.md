---
name: exif-orientation
description: Fix images that appear rotated or flipped because EXIF orientation metadata was ignored or double-applied
category: image
---

# EXIF Orientation

Reach for this when photos (often phone camera uploads) show up sideways or upside-down in your app but look correct in the OS file viewer — or vice versa.

1. Reproduce with the actual offending file (orientation bugs are per-file); confirm it looks correct in a viewer that honors EXIF and wrong in your pipeline, or the reverse.
2. Read the EXIF Orientation tag (values 1–8). Values other than 1 mean the stored pixels are rotated/mirrored and metadata says how to display them. `exiftool`, `identify -verbose`, or `PIL.Image.getexif()` will show it.
3. Decide the symptom class: if your app ignores the tag, the image stays in stored (sideways) orientation. If two layers BOTH apply it (e.g. browser auto-rotates AND your code rotates), it gets double-rotated.
4. Normalize once, early: bake the orientation into the pixels (e.g. `ImageOps.exif_transpose`) immediately after decode, then STRIP the orientation tag so nothing downstream re-applies it.
5. Verify across the consumers: thumbnail generator, the viewer/browser, and any re-encode step must all agree — test a sideways and a mirrored sample (orientation 6 and 2 are good probes).
6. Check the encode path too: when you write the corrected image, ensure you don't copy the old orientation tag back into the output.

## Rules
- Apply EXIF orientation exactly once, then remove the tag — double-application is the most common regression.
- Browsers and image CDNs may auto-rotate; account for whether the consumer already honors EXIF before you also rotate.
- Cropping/face-detection/coordinate work must happen AFTER orientation is baked in, or boxes land on the wrong region.
- Test orientation 6 (rotate 90 CW) and 2/4 (mirrored) specifically — plain 180 hides flip vs rotate confusion.
- Don't trust width/height from headers before normalization; a sideways image reports swapped dimensions.
