---
name: webhook
description: Implement a webhook receiver with signature verification and idempotency
category: api
---

# Webhook

Use when accepting inbound webhooks from a third party (Stripe, GitHub, etc.) — you must verify authenticity and process safely.

1. Capture the raw request body before any JSON parsing — signature verification needs the exact bytes, not a re-serialized object.
2. Read the signature header and shared secret, recompute the HMAC, and compare with a constant-time check; reject with 401 on mismatch.
3. Reject stale events using the provider's timestamp (tolerance window) to block replay attacks.
4. Deduplicate by the provider's event id so retries don't double-process — store seen ids or use a unique constraint.
5. Acknowledge fast: return 2xx immediately and hand slow work to a queue/background job so the provider doesn't time out and retry.
6. Test signature pass/fail, a replayed event, and a duplicate-id delivery.

## Rules
- Never trust the payload until the signature verifies; verify against the raw body, framework body-parsers often mutate it.
- Use a constant-time comparison for signatures to avoid timing leaks; `==` on the digest is a vulnerability.
- Make handling idempotent — providers deliver at-least-once and will retry on any non-2xx or timeout.
- Return 2xx for accepted-but-unprocessed events; do real work async so a slow handler doesn't trigger redelivery storms.
- Keep the secret in env/secret storage, never in code, and scope it per-provider.
