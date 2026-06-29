---
name: deploy
description: Write a repeatable deployment script or checklist that ships the app safely with a rollback path
category: ci-cd
---

# Deploy

Reach for this when shipping to an environment needs to be repeatable, reviewable, and recoverable instead of ad-hoc.

1. Establish prerequisites: required env vars/secrets present, target reachable, correct branch/tag, clean working tree.
2. Run the gate before shipping — build the release artifact and run tests/lint; abort the script on any failure (`set -euo pipefail`).
3. Capture the current version/revision so you have a concrete rollback target.
4. Deploy the artifact (push image, run migrations, restart/switch traffic) in a defined order, migrations before code that needs them.
5. Verify post-deploy: hit the healthcheck and a smoke endpoint; fail the deploy if they don't pass.
6. Document rollback (redeploy the captured previous version) and announce success only after verification passes.

## Rules
- Make the script idempotent and fail-fast (`set -euo pipefail`); a half-run deploy must not look successful.
- Always record the prior version before changing anything so rollback is one command.
- Run DB migrations in their own step with a tested down/rollback path.
- Never hardcode secrets in the script — read them from the environment or a secret store.
- Gate "done" on a real healthcheck/smoke test, not just "the command exited 0".
