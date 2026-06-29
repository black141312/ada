---
name: cloudformation
description: Write a CloudFormation template with parameters, resources, and outputs
category: cloud
---

# CloudFormation

Reach for this when you're deploying AWS infrastructure as a single managed stack and want native rollback, drift detection, and change sets instead of imperative scripts.

1. Start the template with `AWSTemplateFormatVersion`, a `Description`, and the `Parameters` callers will supply.
2. Define `Resources` with logical IDs, referencing parameters and other resources via `!Ref` and `!GetAtt` instead of hardcoding.
3. Use `Mappings` and `Conditions` for region/environment branching rather than duplicating resources.
4. Export the IDs/ARNs/endpoints other stacks need in `Outputs`, with `Export` names when cross-stack referencing.
5. Validate with `aws cloudformation validate-template` and lint with `cfn-lint` before deploying.
6. Deploy via a change set (`aws cloudformation deploy` / `create-change-set`) so you review the diff before it applies.

## Rules
- Add `DeletionPolicy: Retain` (or `Snapshot`) to stateful resources like databases and buckets so a stack delete doesn't wipe data.
- Use `Parameters` with `AllowedValues`/`NoEcho` for inputs and constraints; mark secrets `NoEcho: true`.
- Prefer nested stacks or modules over one giant template once it grows past ~a few hundred lines.
- Don't put plaintext secrets in templates — reference SSM Parameter Store or Secrets Manager dynamic references.
- Tag resources via a stack-level or per-resource `Tags` block for cost allocation and ownership.
