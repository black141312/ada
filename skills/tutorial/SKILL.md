---
name: tutorial
description: Write a getting-started tutorial that takes a new user from install to a first working result
category: docs
---

# Tutorial

Use this to create a guided, linear walkthrough that gets a newcomer to a small success quickly. Unlike reference docs, a tutorial is a single happy path the reader follows top to bottom.

1. Pick one concrete end goal a beginner can reach in 10-15 minutes ("send your first request", "render a page").
2. State prerequisites up front: tools, accounts, versions the reader must have.
3. Break the path into numbered steps; each step is one action with the exact command or code to paste.
4. After each step, show the expected output so the reader can confirm they're on track.
5. End with a working result, then a short "next steps" pointing to deeper docs.
6. Add a brief troubleshooting note for the one or two failures beginners actually hit.
7. Run the whole tutorial from a clean environment yourself and fix anything that doesn't work verbatim.

## Rules
- One linear happy path — defer options, edge cases, and theory to reference docs.
- Every code block must be copy-pasteable and produce the shown output.
- Show expected output after steps so readers can self-correct.
- Test it end to end from a fresh setup; a tutorial that fails at step 3 is worse than none.
- Keep prerequisites honest and minimal; don't assume tools the reader hasn't installed.
