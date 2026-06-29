---
name: readme
description: Write or refresh a README covering what the project is, why it exists, install, and usage
category: docs
---

# Readme

Reach for this when a repo has no README, a stale one, or a wall of text nobody reads. The goal is a doc that gets a newcomer from clone to running in minutes.

1. Skim the codebase to confirm what the project actually does: entry points, package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`), and any existing docs.
2. Open with a one-line description and a short "why" — the problem it solves, who it's for.
3. Write an Install section with the exact commands you verified work (clone, dependency install, build).
4. Write a Usage section with a minimal copy-pasteable example that produces visible output.
5. Add Configuration (env vars, flags, config files) only if the project needs it — link don't inline long tables.
6. Add short sections as warranted: Requirements/prerequisites, Development/contributing, License.
7. Run the install and usage commands yourself; fix the README to match reality before finishing.

## Rules
- Lead with what it does and why, not a logo or badge wall.
- Every command must be one you actually ran or verified — no aspirational steps.
- Keep it scannable: headings, short paragraphs, fenced code blocks with language hints.
- Don't document internals or every flag; link to deeper docs instead of bloating the README.
- Match the project's existing tone and the real install method (npm vs pnpm, pip vs uv).
