---
name: svelte-store
description: Create and consume Svelte stores for shared cross-component state
category: frameworks
---

# Svelte Store

Use when state must be shared across components or live outside the component tree — reach for a store instead of prop-drilling.

1. Create a module (e.g. `src/lib/stores.js`) and export a `writable(initial)` for mutable state or `readable` for external/read-only sources.
2. For derived state, use `derived(source, ($source) => ...)` so it recomputes automatically.
3. In components, subscribe with the `$store` auto-subscription in markup and script — Svelte handles unsubscribe.
4. Update state via `store.set(value)` or `store.update(prev => next)`; for `$store = x` shorthand, ensure you're in a component.
5. For encapsulated logic, wrap the store in a factory returning `{ subscribe, ...customMethods }` (the custom-store pattern).
6. Verify reactivity across components and that no manual subscription leaks (prefer `$` over `.subscribe` in components).

## Rules
- Use the `$` prefix in components to auto-subscribe and auto-unsubscribe; only call `.subscribe()` manually outside components, and always clean it up.
- `readable` needs a stop/cleanup function returned from its start callback for timers/listeners.
- Don't put non-serializable or per-request state in a module-level store in SSR contexts — it's shared across requests.
- Keep store mutation logic in the store module (custom stores), not scattered across components.
- `derived` is read-only; never try to `set` a derived store.
