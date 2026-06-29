---
name: ts-generics
description: Improve TypeScript generics and inference so call sites stay type-safe without manual annotations
category: languages
---

# Ts Generics

Reach for this when an API forces callers to annotate types manually, returns `any`, or loses the relationship between input and output types.

1. Identify where types are flowing through: a function/class that takes a value and should return a type derived from it is a generics candidate.
2. Introduce type parameters that get inferred from arguments (`function get<T>(obj: T, key: keyof T)`) so callers never pass `<...>` explicitly.
3. Constrain parameters with `extends` (`<T extends Record<string, unknown>>`) to enable property access and reject bad inputs at the call site.
4. Use conditional and mapped types (`T extends U ? A : B`, `{ [K in keyof T]: ... }`) and `infer` to transform types instead of widening to `any`.
5. Preserve literal types where they matter with `const` type parameters (`<const T>`) or `as const`, so unions don't collapse to `string`/`number`.
6. Verify inference with type-level tests (`expectTypeError` / `// @ts-expect-error`) and by hovering real call sites — confirm no caller needs explicit args.

## Rules
- A generic that appears only once in a signature is usually pointless — each type parameter should connect at least two positions (input↔output).
- Constrain before you access: you can't read `t.id` off an unconstrained `T` — add `extends { id: ... }`.
- Don't over-engineer; if a plain union or overload is clearer than a conditional type, use it.
- Keep error messages legible — deeply nested conditional types produce inscrutable errors; name intermediate types as aliases.
- Default type parameters (`<T = unknown>`) for ergonomics, but never default to `any`.
