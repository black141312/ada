---
name: doc-lint
description: Lint docs in CI for broken links, spelling, and style so prose breakage fails the build like code does.
category: docs
---

# Doc Lint

Use when docs are drifting — dead links, typos, inconsistent style — and you want automated gates instead of manual proofreading.

1. Link-check: run `lychee` (or `markdown-link-check`) across the docs tree to catch dead internal and external URLs.
2. Spell-check with a project dictionary: `cspell` with a committed `cspell.json` allow-list for domain terms.
3. Style/lint Markdown with `markdownlint` (or Vale for prose style rules like passive voice, weasel words, heading case).
4. Add a config to silence intentional exceptions (ignore patterns, allowed words) — keep it in-repo, not in flags.
5. Wire all three into CI as a `docs-lint` job that fails the PR on new violations.
6. Run the same commands locally / in a pre-commit hook so authors catch issues before pushing.
7. Triage existing noise once with a baseline, then enforce zero-new-violations going forward.

## Rules
- Make link-checking non-blocking-on-flakes: cache, retry, and allow-list known-flaky external hosts so CI isn't red from someone else's outage.
- Commit dictionaries and ignore lists; reviewers should see what's being suppressed.
- Treat new violations as build failures; warnings get ignored forever.
- Scope linters to `docs/**` and Markdown — don't let them choke on generated files or vendored content.
- Vale style rules are opinions: tune them to the team's voice, don't adopt a vendor preset wholesale.
