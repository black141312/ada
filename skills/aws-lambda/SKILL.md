---
name: aws-lambda
description: Scaffold an AWS Lambda with a least-privilege IAM role and a clean handler
category: cloud
---

# AWS Lambda

Use this to create a deployable Lambda function — handler code, an execution role scoped to exactly what it touches, and the wiring (env, timeout, trigger).

1. Write the handler with the runtime's expected signature (`handler(event, context)`), keeping the entry thin and the logic in testable functions.
2. Initialize clients and read config (env vars) at module scope so they're reused across warm invocations.
3. Define an IAM execution role granting only the actions/resources this function needs, plus `AWSLambdaBasicExecutionRole` for logs.
4. Declare the function in IaC (Terraform/SAM/CDK): runtime, `handler`, `memory_size`, `timeout`, env vars, and the role ARN.
5. Wire the trigger (API Gateway, EventBridge, SQS, S3) and grant the source permission to invoke.
6. Test locally (`sam local invoke` or a unit test passing a sample event) before deploying.
7. Add structured logging and set a `CloudWatch` log retention so logs don't accumulate forever.

## Rules
- Scope IAM to specific resource ARNs and actions — never attach `*` or broad managed policies like `AdministratorAccess`.
- Pull secrets from Secrets Manager/SSM at runtime, not from plaintext env vars.
- Set a realistic `timeout` and `memory_size`; the default 3s timeout silently fails many functions.
- Make handlers idempotent — retries (SQS, async) will re-deliver events.
- Don't store state in `/tmp` expecting persistence; treat every invocation as potentially cold.
