---
name: vue-composition
description: Migrate a Vue Options API component to the Composition API with script setup
category: frameworks
---

# Vue Composition

Use when converting a Vue 2/3 Options API component to `<script setup>` with the Composition API, keeping reactivity and lifecycle behavior intact.

1. Replace the Options block with `<script setup>`; declare `defineProps` and `defineEmits` for the component's props and events.
2. Convert each `data()` field to `ref()` (primitives) or `reactive()` (objects); access `.value` for refs in script.
3. Turn `computed` options into `computed(() => ...)` and `watch`/`watchEffect` for the watchers.
4. Move `methods` to plain functions in setup; map lifecycle hooks (`mounted` → `onMounted`, `beforeUnmount` → `onBeforeUnmount`, etc.).
5. Extract reusable logic into composables (`useXxx()` functions returning refs) instead of mixins.
6. Run the app; verify reactivity (template updates), emitted events, and that hooks fire in order.

## Rules
- In the template, refs auto-unwrap — don't write `.value` there; in script you must.
- Destructuring a `reactive` object breaks reactivity; use `toRefs` if you need to spread it.
- `defineProps`/`defineEmits` are compiler macros — don't import them; they only work in `<script setup>`.
- Replace `this.$emit` with the function returned by `defineEmits`, and `this.$refs` with template `ref()`.
- Prefer composables over mixins; keep each composable focused on one concern and return only what's needed.
