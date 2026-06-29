---
name: android-compose
description: Build a Jetpack Compose screen with hoisted state and a ViewModel
category: mobile
---

# Android Compose

Use this when building a screen in Jetpack Compose, separating stateless composables from the state held in a `ViewModel` and exposed as `StateFlow`.

1. Write the screen as a `@Composable` function in PascalCase that takes its state and event lambdas as parameters (state hoisting), keeping it stateless and previewable.
2. Hold real state in a `ViewModel` exposed via `StateFlow`/`MutableStateFlow`, and collect it with `collectAsStateWithLifecycle()`.
3. For purely local UI state (expanded, text input) use `remember { mutableStateOf(...) }`, and `rememberSaveable` for state that must survive config changes.
4. Provide a route composable that pulls the `ViewModel` (`viewModel()` / Hilt) and passes state + callbacks down into the stateless screen.
5. Use `Modifier` for layout/styling, scaffold structure with `Scaffold`/`Column`/`LazyColumn`, and pull colors from `MaterialTheme`.
6. Add an `@Preview` composable with sample state, then verify recomposition and clicks with a Compose UI test (`createComposeRule`, `onNodeWithText`).

## Rules
- Hoist state up and keep leaf composables stateless so they're easy to preview and test.
- Never read or mutate `mutableStateOf` outside composition without `remember` — it resets every recomposition.
- Keep composables side-effect free; launch coroutines via `LaunchedEffect`/`rememberCoroutineScope`, not inline in the body.
- Pass stable types and lambdas to avoid needless recomposition; use `key` in lazy lists.
- Don't hold Android `Context`/`Activity` references in a `ViewModel`; survive rotation via the ViewModel, not the composable.
