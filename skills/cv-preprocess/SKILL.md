---
name: cv-preprocess
description: Fix CV model preprocessing mismatch — resize, normalize, mean/std, channel layout, value range
category: image
---

# CV Preprocess

Reach for this when a vision model's accuracy is far below expected (or predictions are nonsense) and you suspect the input preprocessing doesn't match what the model was trained with.

1. Reproduce with one image and a known-correct reference: run the model's official/example preprocessing on it and diff your tensor against theirs element-wise. The discrepancy localizes the bug.
2. Verify resize method and size: bilinear vs bicubic vs nearest, antialias on/off, and whether it's resize-then-center-crop vs squash-to-square. Mismatched interpolation shifts accuracy quietly; wrong crop changes the framing.
3. Check value range and order of operations: scale to `0–1` BEFORE applying mean/std normalization, and confirm the mean/std are in the same scale (ImageNet `mean=[0.485,0.456,0.406]` assumes 0–1 input, not 0–255).
4. Confirm channel order matches training: RGB vs BGR (Caffe-era models often want BGR), and that your normalization constants are listed in that same channel order.
5. Verify tensor layout: NCHW vs NHWC. Feeding HWC where CHW is expected (or a missing batch dim) either errors or transposes the image into garbage. Print the final tensor shape.
6. Check dtype and device: float32 vs float16, and that no implicit uint8 truncation happened before normalization.
7. Lock it: assert the final tensor's shape, dtype, and min/max/mean against the reference pipeline's values.

## Rules
- Match the model's training preprocessing exactly — copy the official transform rather than reinventing it.
- Scale to 0–1 before mean/std unless the constants are explicitly in 0–255 space.
- mean/std order, RGB/BGR order, and channel layout (CHW/HWC) must all agree with training.
- Antialias and interpolation choice measurably affect accuracy; don't assume the default matches.
- Diff your final tensor numerically against a reference; "the image looks fine" doesn't catch normalization errors.
