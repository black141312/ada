---
name: react-perf
description: Diagnose and eliminate needless React re-renders with memoization
category: frameworks
---

# React Perf

Use when a component tree re-renders too often or feels janky, and you need to find and cut the wasted work — measure first, optimize second.

1. Profile with the React DevTools Profiler (or `<Profiler>`) to find which components re-render and why; don't guess.
2. Identify the trigger: a new object/array/function prop created each render, an over-broad context, or state lifted too high.
3. Stabilize prop identities with `useMemo` (values) and `useCallback` (functions) so memoized children actually skip renders.
4. Wrap pure leaf/list components in `React.memo`; for lists, ensure stable `key`s that aren't array indices.
5. Split or scope context, or lift state down, so a frequently-changing value doesn't re-render the whole subtree.
6. Re-profile to confirm the render count dropped; remove any memoization that didn't move the needle.

## Rules
- Never optimize without a before/after measurement — memoization has its own cost.
- `React.memo` is useless if you pass it a freshly-created object/callback each render; fix the parent first.
- Inline `{}`/`[]`/`() => {}` in JSX create new references every render — hoist or memoize them.
- A `useMemo`/`useCallback` with wrong deps reintroduces the bug or causes stale closures; keep deps honest.
- Heavy work in render belongs in `useMemo` or out of the component; effects don't make render faster.
