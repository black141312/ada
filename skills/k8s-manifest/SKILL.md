---
name: k8s-manifest
description: Write Kubernetes Deployment, Service, and Ingress manifests with sane defaults
category: cloud
---

# K8s Manifest

Use this to stand up a stateless workload on Kubernetes — a Deployment fronted by a Service and exposed via an Ingress — without missing the production-critical fields people forget.

1. Write the `Deployment` with explicit `replicas`, matching `selector`/`template` labels, and a pinned image tag (never `:latest`).
2. Set `resources.requests` and `resources.limits` for cpu and memory on every container.
3. Add `livenessProbe` and `readinessProbe` (HTTP or exec) so rollouts and restarts behave.
4. Write the `Service` (usually `ClusterIP`) selecting the same pod labels and naming the target port.
5. Write the `Ingress` with host rules, a `pathType`, the backend Service, and TLS referencing a cert Secret.
6. Validate with `kubectl apply --dry-run=server -f .` (or `kubeval`) and `kubectl diff` before applying.

## Rules
- Always run as non-root: set `securityContext` with `runAsNonRoot: true`, drop capabilities, and `readOnlyRootFilesystem` where possible.
- Keep config in `ConfigMap`/`Secret` and inject via `envFrom`/`valueFrom` — no secrets baked into manifests or images.
- Label consistently (`app`, `app.kubernetes.io/name`, `version`) so selectors and tooling work.
- Set a `Namespace` explicitly or via kustomize; don't rely on `default`.
- Prefer a rolling `strategy` with `maxUnavailable`/`maxSurge` tuned for your replica count.
