---
name: contributing
description: Add CONTRIBUTING and CODE_OF_CONDUCT files tailored to the repo's actual workflow
category: compliance
---

# Contributing

Reach for this when an open-source or team repo lacks contributor guidance, or when onboarding friction shows the docs are missing or stale.

1. Inspect the repo to learn the real workflow: branch model, how tests/lint run, the build command, PR conventions, and existing issue/PR templates.
2. Write `CONTRIBUTING.md` covering: how to set up the dev environment, run tests and lint, the branch/commit/PR convention, and how to report bugs or request features.
3. Add a `CODE_OF_CONDUCT.md` — adopt the Contributor Covenant (current version) and fill in a real enforcement contact email.
4. Cross-link them from `README.md` and reference the CoC from `CONTRIBUTING.md`; place files at repo root (or `.github/`) so GitHub surfaces them.
5. Include the concrete commands a contributor runs (install, test, lint, format) copied from `package.json`/`Makefile`/CI so they actually work.
6. Verify links resolve and any badges/paths are correct, then open a PR.

## Rules
- Use commands and conventions that exist in this repo — never paste a generic template with placeholder steps that do not run.
- The Code of Conduct enforcement contact must be a real, monitored address, not `INSERT EMAIL`.
- Keep CONTRIBUTING focused and skimmable; link out to deeper docs rather than duplicating them.
- Don't contradict CI: if CI requires signed commits, conventional commits, or a CLA, state it explicitly.
- Match the license and governance already in the repo; do not introduce new policies the maintainers haven't agreed to.
