---
name: flutter-widget
description: Build a Flutter widget that owns and updates local state
category: mobile
---

# Flutter Widget

Reach for this when you need a reusable Flutter widget that holds and mutates its own state (toggles, counters, form fields, animations) rather than a pure stateless layout.

1. Decide stateless vs stateful: if nothing changes after build, use `StatelessWidget`; if the widget mutates over its lifetime, use `StatefulWidget` with a paired `State` class.
2. Declare constructor params as `final` fields and pass a `Key? key` through to `super`; mark required params `required`.
3. Put mutable values as fields on the `State` class and wrap every mutation in `setState(() { ... })` so the framework reschedules `build`.
4. Implement `build(BuildContext context)` returning the widget tree; pull colors and text styles from `Theme.of(context)` instead of hardcoding.
5. Override `initState` for one-time setup (controllers, listeners) and `dispose` to tear them down; never start work in the constructor.
6. Run `flutter analyze` and exercise the widget with a `WidgetTester` (`pumpWidget`, `tap`, `pump`) to confirm state transitions.

## Rules
- Never call `setState` in `build`, after `dispose`, or inside `initState` — it triggers loops or "called after disposed" errors.
- Always `dispose` of `AnimationController`, `TextEditingController`, `FocusNode`, and stream subscriptions.
- Keep `build` pure and cheap: no I/O, no allocations you can hoist, no side effects.
- Prefer `const` constructors and `const` child widgets to cut rebuild cost.
- For state shared across the tree, lift it up or use a state-management package instead of widget-local `setState`.
