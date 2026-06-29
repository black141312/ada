---
name: ocr-debug
description: Improve OCR accuracy — binarize, deskew, raise DPI, set language, fix contrast and noise
category: image
---

# OCR Debug

Reach for this when OCR output is garbled, missing text, or has frequent character errors, and you need to improve the input image rather than the engine.

1. Reproduce on the specific failing image and save the EXACT bitmap handed to the OCR engine (post-preprocessing) — OCR errors are usually caused by the preprocessed image, not the original.
2. Check effective resolution: OCR engines want ~300 DPI for body text. Upscale small/low-DPI scans before recognition; tiny text is the most common cause of garbage output.
3. Deskew and de-rotate: even a few degrees of skew wrecks line segmentation. Detect skew angle and rotate to horizontal; fix upside-down pages (orientation detection) too.
4. Improve contrast and binarize thoughtfully: convert to grayscale, then adaptive/Otsu threshold to clean black-on-white. Over-aggressive global thresholding erases faint strokes — compare adaptive vs Otsu on the sample.
5. Remove noise and background: despeckle, drop background gradients/watermarks, and crop to the text region so the engine isn't distracted by borders, photos, or table rules.
6. Set the right language and character set: wrong language model, or not restricting to a digit/uppercase whitelist when appropriate, causes systematic substitutions (O/0, l/1).
7. Measure: compare recognized text to ground truth (character error rate) before and after each change so you keep only steps that help.

## Rules
- Inspect the post-preprocessing bitmap the engine actually sees; that's where the accuracy is decided.
- Aim for ~300 DPI of text height; upscaling beats feeding tiny glyphs.
- Deskew and fix orientation before binarizing — skewed lines defeat segmentation.
- Over-binarizing erases thin strokes; tune threshold on the real sample, prefer adaptive for uneven lighting.
- Always set the correct language; constrain the charset when the domain allows (digits-only, etc.).
