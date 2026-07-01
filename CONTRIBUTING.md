# Contributing to ada

Thanks for your interest. ada is deliberately small and dependency-light: TypeScript run straight
through `tsx`, **no build step**. The whole thing is meant to stay readable in an afternoon.

## Branches

Simple GitHub flow — `main` is the only long-lived branch:

- **`main`** is always releasable. Branch from it, open your PR against it.
- Feature/fix work happens on a short-lived branch (`my-change`), PR'd back to `main`.
- CI (`typecheck` + `selfcheck`) runs on every push and PR to `main`.

```bash
git switch main && git pull
git switch -c my-change      # work, commit
# open a PR with base = main
```

### Cutting a release (maintainers)

1. On your branch (or directly on `main` for a trivial bump), update `package.json` `version` and add
   a `CHANGELOG.md` entry. Merge to `main`.
2. From `main`, run the release script — it tags `v<version>`, pushes, and watches the publish:
   ```bash
   git switch main && git pull
   npm run release            # or: npm run release -- --no-watch
   ```
   It refuses unless you're on a clean `main` and the tag is new, so it can't tag the wrong commit.
3. The **Release** workflow takes over: verifies the tag matches `package.json`, runs the gates,
   `npm publish`es `ada-agent`, and creates the GitHub release. Requires the repo secret `NPM_TOKEN`
   (a **classic Automation** token — not Granular/Publish, which prompt for an OTP that CI can't
   supply).

## Setup

```bash
git clone https://github.com/black141312/ada.git
cd ada
npm install
npm link            # puts `ada` / `ada-server` on PATH (or just `npm start`)
```

## Before you open a PR

```bash
npm run typecheck   # tsc --noEmit — must be clean
npm run selfcheck   # offline checks: tools, sessions, routing, parsers, the destructive classifier…
```

- **Leave a check behind.** Non-trivial logic (a parser, a branch, a money/security path) gets one
  assertion in `src/selfcheck.ts` — the smallest thing that fails if it breaks. No frameworks.
- **Stay lean.** Prefer the stdlib/native path; fewest files; shortest diff that works. Don't add a
  dependency for what a few lines can do.
- **Match the surrounding style** (the repo is formatted close to Biome/Prettier defaults — 2-space,
  double quotes, semicolons).

## Where things live

- `src/server` — the backend: routes a request to the right provider and holds the keys. A new
  OpenAI-compatible provider is **two lines** (`config.ts` + `providers/registry.ts`).
- `src/client` — the terminal agent: the loop, tools, skills, sessions, TUI. A new tool is one entry
  in `tools.ts`; a new skill is a `SKILL.md` under `skills/<name>/`.
- Design notes: [docs/architecture.md](docs/architecture.md),
  [docs/orchestration.md](docs/orchestration.md), [docs/integrations.md](docs/integrations.md).

## Reporting

Bugs and feature ideas → open an issue. Security vulnerabilities → see
[SECURITY.md](SECURITY.md) (please don't file those publicly).

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
