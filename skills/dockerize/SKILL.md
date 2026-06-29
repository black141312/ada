---
name: dockerize
description: Write a Dockerfile and .dockerignore that build a small, reproducible image for the app
category: ci-cd
---

# Dockerize

Use when the app needs a container image to build, ship, or run consistently across environments.

1. Identify the runtime, entrypoint, and exposed port from the project (start script, `main`, server bind address).
2. Choose a slim, pinned base image (e.g. `node:20-slim`, `python:3.12-slim`) — avoid `latest`.
3. Use a multi-stage build: a builder stage that installs deps and compiles, a final stage that copies only the runtime artifacts.
4. Copy dependency manifests first and install before copying source, so layer caching survives source-only edits.
5. Run as a non-root user, set `WORKDIR`, `EXPOSE` the port, and use exec-form `CMD`/`ENTRYPOINT` (`["node","server.js"]`).
6. Write a `.dockerignore` (`.git`, `node_modules`, build output, `.env`, tests) then `docker build` and run the container to confirm it starts.

## Rules
- Pin the base image tag/digest; never depend on `latest`.
- Order layers cheapest-to-change first (deps before source) to maximize cache hits.
- Never bake secrets or `.env` files into the image — pass them at runtime.
- Drop to a non-root user before the final `CMD`.
- A missing `.dockerignore` bloats context and can leak local files — always create one.
