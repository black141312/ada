---
name: runbook
description: Write an operational runbook an on-call engineer can follow at 3am to detect, diagnose, and resolve an incident.
category: docs
---

# Runbook

Use when a recurring operational procedure (deploy rollback, failover, disk-full, cert rotation) needs to be executable by someone tired, paged, and unfamiliar with the system.

1. State the trigger up front: the exact alert name, symptom, or condition that means "run this" — so on-call knows they're in the right doc.
2. List prerequisites: required access/roles, tools, dashboards, and the blast radius / who to notify before acting.
3. Add a fast diagnosis section — concrete commands and dashboard links to confirm the problem and rule out look-alikes.
4. Write resolution as numbered, copy-pasteable steps with the *expected output* after each, so they can tell if it worked.
5. Include a verification step ("service healthy when X") and a rollback/abort path if the fix makes things worse.
6. End with escalation: who/what team to page, and how to capture state for the postmortem.
7. Date the last test/review and note who owns it.

## Rules
- Every command must be copy-pasteable and parameterized with `<placeholders>`, never with real prod values inline.
- Show expected output / success signal after risky steps — silence isn't confirmation.
- Always give an abort/rollback path; a runbook with no exit is a trap.
- Link the live dashboard/log query, don't paste a stale screenshot.
- Test the runbook in a drill; an untested runbook is a guess. Mark it `UNTESTED` until then.
- Keep it dumb-simple — assume zero context and high stress.
