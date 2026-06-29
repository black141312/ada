---
name: e2e-test
description: Write an end-to-end test that drives the real app through a user flow with Playwright or Cypress
category: testing
---

# E2E Test

Use when you need to verify a complete user journey through the running app, not isolated units.

1. Identify the user-facing flow and its success criteria (what the user does, what they should see/get at the end).
2. Set up the test against a real or test-seeded environment; ensure known starting state (logged-out, empty cart, etc.).
3. Drive the flow by user-visible interactions — click buttons, fill fields, follow links — as a real user would.
4. Locate elements by accessible role, label, or test id rather than brittle CSS/XPath tied to styling.
5. Assert on observable outcomes (visible text, URL, network result), using the framework's auto-waiting instead of fixed sleeps.
6. Run it headless and headed, confirm it passes repeatably, and wire it into CI.

## Rules
- Test critical paths end-to-end (signup, checkout, core action); keep E2E count small since they are slow and costly.
- Select elements by role/label/`data-testid`, never by auto-generated class names or deep DOM position.
- Rely on built-in waiting for conditions; never paper over timing with `sleep`/fixed `waitForTimeout`.
- Seed and reset state per test so runs are independent and repeatable; don't depend on leftover data.
- Keep secrets and base URLs in env/config, not hardcoded, so the test runs across local/CI/staging.
