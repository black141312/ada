---
name: feature-engineering
description: Engineer features for a model without leakage and reproducibly
category: data-ml
---

# Feature Engineering

Use when deriving model inputs from raw data — encodings, aggregates, time-window features — and you need them correct, leakage-free, and consistent between training and serving.

1. Start from the prediction point: for each row, only use information available before the label is known (the "as-of" time).
2. Derive features explicitly — encodings, ratios, datetime parts, rolling/window aggregates, and target-relative stats — one transform at a time.
3. Fit any feature that learns from data (scalers, target/mean encoders, imputers) on the training split only, then apply to val/test.
4. For time-windowed and aggregate features, compute them strictly from past rows to avoid look-ahead leakage.
5. Encapsulate the transformations so the exact same code runs at training and at serving (avoid train/serve skew).
6. Check feature distributions, null rates, and correlation with the target; drop constant, duplicate, or leaky features.

## Rules
- Leakage is the cardinal sin: never use future information or the target (directly or via fitted stats) for a row's features.
- Fit data-dependent transforms on train only; refit per fold under cross-validation.
- Use the same transformation code path in training and production to prevent train/serve skew.
- Respect the as-of time for every time-based feature — joins and rolling windows must not peek ahead.
- A feature that's suspiciously predictive is usually leakage; investigate before trusting it.
