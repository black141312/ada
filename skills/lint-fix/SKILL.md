---
name: lint-fix
description: Run the project linter and fix the violations it reports
category: review
---

# Lint Fix

Use this to get a clean lint run — discover the project's linter, run it, and resolve every violation without suppressing problems you should actually fix.

1. Identify the configured linter from the manifest/config (e.g. `eslint`, `ruff`, `clippy`, `golangci-lint`, `rubocop`) and its invocation script.
2. Run the linter across the changed files (or the whole project if that's the convention) and capture the full list of violations.
3. Apply the safe autofix mode first (`--fix`, `ruff check --fix`, `cargo clippy --fix`) and re-run to see what remains.
4. Fix remaining violations by hand — address the underlying issue rather than reaching for an inline disable.
5. Re-run the linter until it reports zero violations, then run the test suite to confirm fixes didn't change behavior.
6. Commit the lint fixes separately from feature changes so the diff stays easy to review.

## Rules
- Fix the root cause; only use an inline disable when the rule is genuinely wrong here, with a comment explaining why.
- Never loosen the shared lint config to silence a violation unless that's the explicit, agreed task.
- Re-run after autofix — autofixers can introduce new violations or leave some untouched.
- Keep autofix-only churn (formatting-adjacent) reviewable; don't bundle it with logic changes.
- A green test run is required after fixes — a lint fix that breaks behavior isn't a fix.
