---
name: react-hooks
description: Convert a React class component to a function component using hooks
category: frameworks
---

# React Hooks

Reach for this when modernizing a legacy class component into a function component with hooks, preserving behavior exactly.

1. Read the class: note `state` shape, `props` used, lifecycle methods, instance fields, and bound handlers.
2. Replace the class with a function component; turn each piece of `state` into a `useState` call (group related fields only if they update together).
3. Map lifecycles to effects: `componentDidMount`/`componentWillUnmount` → `useEffect(fn, [])` with a cleanup return; `componentDidUpdate` → `useEffect` with the right deps.
4. Convert instance fields that survive renders (timers, refs to DOM/values) to `useRef`; convert methods to inline functions or `useCallback` if passed as props.
5. Remove `this.`, `bind`, and the constructor; read props directly as the function argument.
6. Run the component and its tests; verify effects fire and clean up the same number of times as the old lifecycles.

## Rules
- One `useEffect` per concern, not one giant effect mirroring `componentDidMount`.
- Every value referenced inside an effect must be in its dependency array; do not silence the exhaustive-deps lint by deleting deps.
- `useState` setters are async and don't merge objects — spread manually or split into multiple states.
- Don't wrap everything in `useCallback`/`useMemo`; add them only when an identity actually matters downstream.
- Preserve the original render output and ref-forwarding behavior; use `forwardRef` if the class exposed a ref.
