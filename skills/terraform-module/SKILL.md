---
name: terraform-module
description: Write a reusable Terraform module with clean inputs, outputs, and pinned providers
category: cloud
---

# Terraform Module

Reach for this when you need to package infrastructure (a VPC, a bucket, an ECS service) so it can be called repeatedly with different inputs instead of copy-pasted HCL.

1. Lay out the standard files: `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, and `README.md` in the module directory.
2. Pin Terraform and provider versions in `versions.tf` with `required_version` and `required_providers` (use `~>` constraints, not floating).
3. Declare every input in `variables.tf` with `type`, `description`, and a sensible `default` only where optional; add `validation` blocks for constrained values.
4. Build resources in `main.tf` using only variables and locals — never hardcode account IDs, regions, names, or CIDRs.
5. Expose the IDs/ARNs/endpoints callers will need in `outputs.tf`, each with a `description`.
6. Run `terraform fmt -recursive`, `terraform validate`, and `terraform-docs markdown table . > README.md` before committing.
7. Add an `examples/` subdir with a minimal working invocation that `init`/`plan` cleanly.

## Rules
- A module must not configure `provider` blocks or backends — that belongs to the root caller.
- Name resources `this` (or by role) and rely on the module name for namespacing; avoid baking the module name into every resource.
- Mark secrets `sensitive = true` and never write them to `outputs` in plaintext.
- Don't use `count`/`for_each` on whole modules to fake conditional creation if a `create` bool + per-resource `count` is clearer.
- Keep provider and state concerns out; a module should be importable into any backend.
