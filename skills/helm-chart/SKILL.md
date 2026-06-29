---
name: helm-chart
description: Author a Helm chart with templated manifests, values, and helpers
category: cloud
---

# Helm Chart

Reach for this when a workload needs to ship to multiple environments with varying config — Helm templates the manifests and exposes the knobs through `values.yaml`.

1. Scaffold with `helm create <name>` then strip the generated boilerplate you don't need.
2. Define the chart contract in `Chart.yaml` (`apiVersion: v2`, `version`, `appVersion`) and declare any subchart `dependencies`.
3. Move all environment-varying values into `values.yaml` with documented defaults; reference them as `.Values.x` in templates.
4. Templatize `templates/*.yaml`, using `_helpers.tpl` for shared label/name logic and `include` to reuse it.
5. Render and lint with `helm lint` and `helm template . -f values-prod.yaml` to eyeball the output.
6. Dry-run against a cluster with `helm install --dry-run --debug` (or `helm upgrade --install`) before going live.
7. Bump `Chart.yaml` `version` on every change and run `helm dependency update` when subcharts change.

## Rules
- Quote templated strings (`{{ .Values.x | quote }}`) and use `default`/`required` to fail fast on missing values.
- Never commit real secrets to `values.yaml`; use `--set`, a secrets plugin, or an external secret store.
- Keep `appVersion` (the app) distinct from chart `version` (the packaging) and bump them independently.
- Indent with `nindent`, not hand-counted spaces, to avoid YAML breakage.
- Provide a `values.schema.json` or sane validation so bad overrides are caught at install time.
