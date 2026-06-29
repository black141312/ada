---
name: py-typing
description: Add Python type hints to existing code and get it passing mypy or pyright cleanly
category: languages
---

# Py Typing

Reach for this when adding type hints to untyped Python or chasing down type-checker errors in a module or package.

1. Pick a checker and pin strictness: `mypy --strict <path>` or `pyright`, and capture the current error count as a baseline.
2. Annotate from the leaves up: type the most-imported helpers and data models first so call sites infer correctly.
3. Replace ambiguous returns with precise types — use `X | None` over bare `Optional` omission, `Sequence`/`Mapping` for read-only params, concrete types for returns.
4. Introduce `TypedDict`, `dataclass`, `Protocol`, or `@overload` instead of `dict[str, Any]` and `# type: ignore` where structure is known.
5. Use `typing.cast` or a narrowing `assert isinstance(...)` only when the checker genuinely can't follow control flow — never to silence a real bug.
6. Re-run the checker, drive the error count to zero, and add a CI step (`mypy` / `pyright`) so it stays there.

## Rules
- Prefer fixing the type over `# type: ignore`; if you must ignore, use a specific code like `# type: ignore[arg-type]` and a comment.
- Don't annotate with `Any` to pass the checker — that defeats the purpose and hides defects.
- Target the project's minimum Python version: use `from __future__ import annotations` or `typing_extensions` for newer constructs on older runtimes.
- Type public APIs precisely; internal locals usually don't need annotations (the checker infers them).
- Keep runtime behavior unchanged — adding hints must never alter logic, and avoid heavy `typing` imports inside hot paths.
