---
name: format
description: Run the project formatter and apply consistent style across changed files
category: review
---

# Format

Use this to apply the project's canonical code style — run the configured formatter so style is consistent and never a review topic.

1. Detect the project's formatter from config (e.g. `prettier`, `black`/`ruff format`, `gofmt`/`goimports`, `rustfmt`, `.editorconfig`) and its run command.
2. Prefer the project script (`npm run format`, `make fmt`) over a global binary so the pinned version and config are used.
3. Run the formatter in write mode, scoped to changed files when possible to keep the diff tight.
4. Inspect the resulting diff to confirm only whitespace/style changed and no logic was touched.
5. Run a `--check`/`--diff` pass to verify the tree is now clean, then run the test suite.
6. Commit formatting on its own so functional diffs aren't buried under style churn.

## Rules
- Use the project's pinned formatter and config — never impose your own style preferences.
- Don't reformat untouched files unless that's the explicit task; mass reformatting destroys blame and bloats reviews.
- If no formatter is configured, match the surrounding file's existing style instead of introducing one.
- Keep formatting commits separate from logic commits for a clean, reviewable history.
- A formatter must be idempotent — if a second run produces a diff, the config or version is mismatched; resolve that.
