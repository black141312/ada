---
name: precommit
description: Set up pre-commit hooks that lint and format staged files before each commit
category: ci-cd
---

# Pre-commit

Reach for this to catch lint/format issues locally before they ever reach CI, keeping commits clean.

1. Pick the mechanism that fits the stack: `pre-commit` (framework, polyglot) or a JS-native combo of `husky` + `lint-staged`.
2. Add the config (`.pre-commit-config.yaml` or `package.json` `lint-staged` block) listing hooks: formatter, linter, and cheap checks.
3. Scope hooks to staged files only and run the same tools CI uses, so local and CI verdicts agree.
4. Install the git hook (`pre-commit install` or husky's `prepare` script) so it runs automatically on `git commit`.
5. Run the hooks across the whole repo once (`pre-commit run --all-files`) to surface and fix existing violations.
6. Document the one-line setup so a fresh clone installs hooks during `npm install` / bootstrap.

## Rules
- Keep hooks fast — only lint/format staged files; push heavy test suites to CI.
- Pin hook/tool versions so every developer runs identical checks.
- Make hooks fixable: prefer auto-formatters that re-stage, and give clear failure messages.
- Pre-commit is a convenience, not a gate — CI must still enforce the same checks (`--no-verify` exists).
- Ensure hooks install on clone (husky `prepare`) so they aren't silently skipped.
