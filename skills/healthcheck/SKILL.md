---
name: healthcheck
description: Add liveness/readiness endpoints so orchestrators and load balancers know when the service is healthy
category: ci-cd
---

# Healthcheck

Reach for this when a service runs under Docker, Kubernetes, or a load balancer that needs to probe whether it's alive and ready for traffic.

1. Add a cheap liveness endpoint (`/healthz`) that returns 200 if the process is up — no external calls.
2. Add a readiness endpoint (`/readyz`) that checks critical dependencies (DB ping, cache, required config) and returns 503 until all pass.
3. Return a small JSON body with overall status and per-dependency results, and set the HTTP status code to match.
4. Keep probes fast and side-effect-free with a short timeout so a slow dependency doesn't hang the check.
5. Wire the probe into the platform: Dockerfile `HEALTHCHECK`, compose `healthcheck`, or k8s `livenessProbe`/`readinessProbe`.
6. Test both states — healthy returns 200, and a downed dependency makes `/readyz` return 503 — before relying on it.

## Rules
- Separate liveness (am I running?) from readiness (can I serve?) — conflating them causes needless restarts.
- Keep checks lightweight and bounded with a timeout; never let a probe block or do heavy work.
- Don't require auth on the probe path, but don't leak secrets or stack details in the body either.
- Make readiness actually fail (503) when a hard dependency is down, or it's decorative.
- Match the HTTP status to reality — orchestrators key off the code, not the JSON.
