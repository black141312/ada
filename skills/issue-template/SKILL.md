---
name: issue-template
description: Add GitHub issue and pull request templates to standardize reports and reviews
category: compliance
---

# Issue Template

Use when a repo gets low-quality or inconsistent issues/PRs, or when setting up a new project's contribution scaffolding.

1. Create `.github/ISSUE_TEMPLATE/` with separate templates for bug reports and feature requests (YAML issue forms preferred, or Markdown with front-matter `name`/`about`/`labels`).
2. In the bug template require: steps to reproduce, expected vs actual, version/environment, and logs — fields that make triage possible.
3. In the feature template ask for: problem/motivation, proposed solution, and alternatives considered.
4. Add `.github/ISSUE_TEMPLATE/config.yml` to set default labels and add `contact_links` (e.g. discussions, security policy) and decide whether to disable blank issues.
5. Add `.github/PULL_REQUEST_TEMPLATE.md` with a summary, linked issue (`Closes #`), testing notes, and a checklist (tests pass, docs updated).
6. Validate YAML syntax and confirm GitHub renders the picker by checking the repo's New Issue page.

## Rules
- Issue forms (`.yml`) need valid YAML and correct field `type` values, or GitHub silently falls back to blank issues — validate before merging.
- Keep required fields minimal; over-long forms suppress reports.
- Reference labels that already exist in the repo, or create them, so auto-labeling doesn't fail.
- Don't route security reports through public issues — link to `SECURITY.md` in `config.yml` instead.
- Place everything under `.github/`; templates elsewhere are ignored by GitHub.
