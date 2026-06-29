---
name: train-model
description: Scaffold a reproducible model training script with proper splits and checkpoints
category: data-ml
---

# Train Model

Use when setting up a training run for a classical ML or deep learning model and you want a reproducible, debuggable script rather than a notebook mess.

1. Split data into train/validation/test up front with a fixed seed; for time series or grouped data, split by time/group to prevent leakage.
2. Fit all preprocessing (scaling, encoding, imputation) on train only, then apply to val/test — wrap in a pipeline so it travels with the model.
3. Set and log seeds, hyperparameters, data version, and code commit so the run is reproducible.
4. Train with a small subset first to confirm the loss decreases and the script runs end-to-end before the full run.
5. Track train and validation metrics each epoch/iteration; checkpoint the best model by the validation metric, not train loss.
6. Add early stopping or a fixed budget, then evaluate the final model on the untouched test set exactly once.
7. Save the model, the fitted preprocessing, and a metrics summary as artifacts.

## Rules
- The test set is touched once, at the very end — never for tuning or model selection.
- Fit preprocessing on train only; fitting on the full dataset leaks the target into training.
- Always run an overfit-one-batch smoke test before committing to a long run.
- Log seed, config, and data version with every run so results can be reproduced.
- Select and checkpoint on the validation metric; report the held-out test metric as the headline number.
