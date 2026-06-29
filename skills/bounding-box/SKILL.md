---
name: bounding-box
description: Debug bounding-box bugs — xyxy vs xywh, normalized vs pixel, scaling after resize, axis order
category: image
---

# Bounding Box

Reach for this when detection/annotation boxes draw in the wrong place, are shifted/scaled, or are off-screen tiny/huge.

1. Reproduce by drawing the boxes on the source image and saving it — visual overlay instantly shows whether boxes are shifted, scaled, swapped, or in the wrong coordinate frame.
2. Identify the format: `xyxy` (x1,y1,x2,y2) vs `xywh` (x,y,w,h) vs center-based `cxcywh` (YOLO). Feeding one where another is expected produces boxes that are offset or sized wrong in a consistent way.
3. Check normalized vs pixel coordinates: values in `0–1` mean normalized (multiply by width/height); values up to image size are pixels. A box at the top-left corner with tiny dimensions usually means normalized coords drawn as pixels.
4. Account for resize/letterbox: if the image was resized or padded before inference, boxes are in the model's input space and must be scaled back (and un-padded) to original-image coordinates.
5. Verify axis order: `(x, y)` vs `(row, col)`/`(y, x)` swaps width and height. A box that looks transposed or lands at a mirrored position is an axis swap.
6. Clamp and sanity-check: ensure `x2 > x1`, `y2 > y1`, and coords within image bounds; negative or out-of-range values point to a sign or scaling error.
7. Confirm with one hand-labeled box whose correct pixel coordinates you know, end to end.

## Rules
- State the format explicitly (xyxy / xywh / cxcywh) at every interface; conversions are where boxes break.
- Normalized boxes need image w/h to render; mixing 0–1 and pixel values is the most common error.
- After any resize/pad/letterbox, transform boxes back to original coordinates — scale AND offset.
- `(x, y)` ordering for boxes vs `(row, col)` numpy indexing swaps W/H; pin it down.
- Always validate by overlaying on the actual image, not by reading numbers alone.
