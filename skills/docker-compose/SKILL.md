---
name: docker-compose
description: Write a docker-compose stack that brings up the app plus its dependencies for local dev
category: ci-cd
---

# Docker Compose

Reach for this when local development needs the app wired to backing services (db, cache, queue) with one command.

1. Inventory the services the app talks to (Postgres, Redis, etc.) from config and connection strings.
2. Define one service per process in `docker-compose.yml`; build the app from its Dockerfile, pull pinned images for dependencies.
3. Wire connectivity by service name (use `db` as the host, not `localhost`) and pass config via `environment` / `env_file`.
4. Add named volumes for data that must persist and bind-mount source for live reload in dev.
5. Add `healthcheck` blocks and `depends_on: condition: service_healthy` so the app starts only after deps are ready.
6. Run `docker compose up`, verify every service is healthy and the app reaches its dependencies, then document the up/down commands.

## Rules
- Reference services by their compose name on the internal network, never `localhost`.
- Pin dependency image tags; keep the app on a build context so code changes rebuild.
- Use `env_file` for local secrets and keep that file out of git.
- `depends_on` alone only waits for start — gate on healthchecks for real readiness.
- Persist stateful data in named volumes so `down` doesn't wipe the dev database unintentionally.
