# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

Use GitHub's private reporting: the repo's **Security** tab → **Report a vulnerability**
([Security Advisories](https://github.com/black141312/ada/security/advisories/new)). Include steps to
reproduce and the impact. You'll get an acknowledgement and a fix or mitigation as soon as practical.

## What ada touches (so you know the blast radius)

- The **backend** (`ada-server`) holds your provider API keys — read **only** from environment
  variables, never hardcoded or committed. Keep it bound to localhost unless you've added auth
  (`ADA_CLIENT_KEYS` / `ADA_REQUIRE_LOGIN`).
- The **client** executes tools — shell commands, file reads/writes, network fetches — **gated by
  your approval** (`ask` mode by default). `auto` mode runs them without prompting; destructive shell
  commands still confirm. Run untrusted repos in `ask` or `plan` mode.
- Login tokens and local config live under `.ada/` / `~/.ada/`, which is git-ignored — never commit it.
- `web_fetch` has an SSRF guard (blocks localhost/private/metadata addresses); MCP/connector tools run
  with the same approval gating.

## Supported versions

ada is pre-1.0 and moves fast — fixes land on `main`. Pull the latest before reporting.
