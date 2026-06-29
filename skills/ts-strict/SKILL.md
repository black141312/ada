---
name: ts-strict
description: Enable TypeScript strict mode and fix the resulting type errors safely
category: languages
---

# Ts Strict

Use this when turning on `strict` (or its sub-flags) in a TypeScript project that compiled loosely, and you need to clear the error wave without papering over real bugs.

1. Enable flags incrementally in `tsconfig.json`: start with `strictNullChecks`, then `noImplicitAny`, then `strictFunctionTypes`, rather than flipping `strict: true` blind.
2. Run `tsc --noEmit` and triage by file/error code; fix the highest-frequency code (often `TS2532` undefined / `TS7006` implicit any) first.
3. For null/undefined errors, narrow with guards (`if (x == null) return`), optional chaining `?.`, or nullish coalescing `??` — not `!` non-null assertions by default.
4. Replace implicit `any` with real types or `unknown` plus a narrowing check; type function params and exported signatures explicitly.
5. Fix unsafe index access (`noUncheckedIndexedAccess`) by handling the `undefined` case from `arr[i]` and `map[key]`.
6. Re-run `tsc --noEmit` until clean, then commit each flag separately so regressions are bisectable.

## Rules
- Prefer `unknown` over `any` when a type is genuinely open — it forces a check at the use site.
- Use `!` and `as` casts sparingly; each one is a place the compiler can no longer protect you — leave a comment justifying it.
- Don't add `// @ts-ignore`/`// @ts-expect-error` to bulk-clear errors; reserve them for known upstream typing bugs and prefer `@ts-expect-error` so they self-remove when fixed.
- Keep `tsconfig` changes and code fixes in lockstep; turning on a flag without fixing its errors breaks the build for everyone.
- Don't loosen library types you don't own — wrap them in a typed adapter instead.
