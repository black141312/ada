---
name: env-setup
description: Add a .env.example and validate required config at startup so missing vars fail fast
category: ci-cd
---

# Env Setup

Use when config is read from environment variables and you want a discoverable template plus a hard fail on missing/invalid values.

1. Grep the codebase for every environment variable read (`process.env.X`, `os.environ[...]`, `getenv`) to build the full list.
2. Create `.env.example` listing each var with a safe placeholder or sane default and a one-line comment on its purpose.
3. Centralize config loading in one module that reads, type-coerces, and validates all vars at startup.
4. Validate on boot with a schema (zod, pydantic, envalid, or a manual check) and exit non-zero with a clear message naming any missing/invalid var.
5. Ensure real `.env` is gitignored and document the `cp .env.example .env` bootstrap step.
6. Run the app with a deliberately missing var to confirm it fails fast with an actionable error rather than crashing later.

## Rules
- Keep `.env.example` in sync with the code — a var read but undocumented is a setup trap.
- Never commit a real `.env` or real secret values; placeholders only in the example.
- Validate at startup, not lazily at first use, so misconfig surfaces immediately.
- Fail with a message that names the offending variable and what it expects.
- Read each var through the central config module, not scattered `process.env` access.
