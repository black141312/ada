---
name: code-examples
description: Add runnable, tested code examples to docs so snippets stay correct and never drift from the API.
category: docs
---

# Code Examples

Use when docs contain code snippets that must actually work — the most damaging doc bug is an example that no longer compiles or runs.

1. Make each example minimal and complete: imports included, no `...` hand-waving, runnable as-is.
2. Show the expected output or result right after the code so readers can confirm they got it right.
3. Extract examples to real source files in an `examples/` dir, then embed them into docs via includes/snippets rather than pasting.
4. Test them: compile/run examples in CI (doctests, `cargo test --doc`, `pytest --doctest`, or a script that executes each `examples/*`).
5. Pin the language/SDK version the examples target and state it, so readers know the context.
6. Cover the happy path first, then one error-handling example — real usage needs both.
7. Re-run examples on every release; a failing example fails the build.

## Rules
- Tested in CI or it will rot — untested examples drift from the API within one release.
- Single source of truth: keep code in real files and include it, don't maintain two copies.
- Examples must be complete and runnable; no pseudo-code, no elided imports.
- Show expected output; an example without a result leaves the reader guessing.
- Prefer realistic, idiomatic usage over contrived `foo`/`bar` that teaches nothing.
