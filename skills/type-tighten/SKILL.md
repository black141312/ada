---
name: type-tighten
description: Strengthen types and remove anys/implicit untyped code in TS or mypy
category: refactoring
---

# Type Tighten

Use when types are loose, missing, or littered with `any`/`Any`, letting bugs slip past the checker. The goal is precise types that document intent and catch errors.

1. Turn on or raise strictness incrementally (`strict`, `noImplicitAny`; mypy `--strict` / `disallow-untyped-defs`) and read the new errors.
2. Replace `any`/`Any` with concrete types, unions, generics, or `unknown` plus a narrowing check.
3. Annotate function signatures (params and returns) so call sites are checked, not just bodies.
4. Add narrowing at boundaries — validate or guard external/JSON input rather than asserting its type.
5. Run the type checker and the test suite; fix real type errors instead of suppressing them.
6. Confirm no runtime behavior changed — types should be erased/ignored at runtime.

## Rules
- Prefer `unknown` over `any` when a type is truly open, then narrow before use.
- Avoid `as`/`cast` and `# type: ignore` as fixes; each one is a hole — justify any you keep with a comment.
- Don't let added types change runtime behavior (e.g. introducing a default value via an annotation).
- Tighten at the edges first (public APIs, I/O boundaries); internal inference often follows for free.
- If a precise type is genuinely impractical, narrow as far as cheaply possible rather than defaulting to `any`.
