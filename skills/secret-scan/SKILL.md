---
name: secret-scan
description: Find secrets accidentally committed to the repo, in history and working tree, and remediate
category: security
---

# Secret Scan

Use this when you suspect (or want to rule out) API keys, tokens, passwords, or private keys committed to a repo.

1. Scan the working tree and full history with a dedicated tool: `gitleaks detect --source . -v` or `trufflehog git file://.`; fall back to grep for high-signal patterns (`AKIA`, `-----BEGIN .* PRIVATE KEY-----`, `xox[baprs]-`, `ghp_`, `sk-`).
2. Check `.env*`, config files, CI YAML, notebooks, and test fixtures — secrets hide outside source code.
3. For each hit, decide if it is a true credential (live/format-valid) vs a placeholder/example, and confirm whether it is in current files, history, or both.
4. For true secrets: rotate/revoke the credential first — assume it is compromised once committed.
5. Remove it from current files, move it to env/secret manager, and add the path to `.gitignore`.
6. If it must be purged from history, use `git filter-repo` (or BFG), force-push, and notify collaborators to re-clone.

## Rules
- Rotation comes before history rewriting — scrubbing git history does not un-leak a key that is already public.
- Treat anything pushed to a remote or a forked/cloned repo as already exposed.
- Add a pre-commit secret hook (gitleaks/`detect-secrets`) so this does not recur.
- Do not print full secret values in logs or PRs; redact to a recognizable prefix.
- Placeholder values (`changeme`, `xxxx`, `your-key-here`) are not findings — verify before alarming.
