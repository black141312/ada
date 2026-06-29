---
name: swiftui-view
description: Build a SwiftUI view with state and two-way bindings
category: mobile
---

# SwiftUI View

Reach for this when building a SwiftUI view that holds local state and drives child controls through two-way `Binding`s (toggles, text fields, sliders, sheets).

1. Define a `struct` conforming to `View` and implement the `var body: some View` computed property.
2. Pick the right property wrapper: `@State` for value-type state owned by this view, `@Binding` for state owned by a parent, `@Observable`/`@StateObject` for reference-type models.
3. Pass mutable state down with the `$` projected value (e.g. `Toggle("On", isOn: $isOn)`) so child controls write back.
4. Compose layout with `VStack`/`HStack`/`ZStack` and modifiers; keep `body` declarative and free of side effects.
5. Add a `#Preview` (or `PreviewProvider`) covering the key states so you can iterate in the canvas without a full build.
6. Drive side effects with `.task`, `.onAppear`, or `.onChange(of:)` — not from inside `body`.

## Rules
- Own a piece of state in exactly one place: `@State` at the source, `@Binding` for children — never duplicate it.
- `@State` properties should be `private`; expose mutation through bindings, not public vars.
- Keep `body` a pure function of state; do networking and persistence in `.task`/model methods.
- Break large `body` blocks into smaller subviews or `@ViewBuilder` computed properties to keep the type-checker fast.
- Use `@StateObject` to create an observable model once; use `@ObservedObject`/`@Bindable` only when it's injected from outside.
