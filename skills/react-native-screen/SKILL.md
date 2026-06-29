---
name: react-native-screen
description: Add a React Native screen and wire it into the navigation stack
category: mobile
---

# React Native Screen

Use this when adding a new screen to a React Native app and registering it with React Navigation so it can be pushed, linked, and typed.

1. Create the screen component (e.g. `screens/DetailsScreen.tsx`) as a function component that destructures `navigation` and `route` from props.
2. Register it on the navigator: add a `<Stack.Screen name="Details" component={DetailsScreen} />` in the stack where it belongs.
3. Extend the param list type (`type RootStackParamList = { Details: { id: string } }`) and type props with `NativeStackScreenProps<RootStackParamList, 'Details'>`.
4. Navigate in with `navigation.navigate('Details', { id })`; read inputs via `route.params` and go back with `navigation.goBack()`.
5. Wrap content in `SafeAreaView` (or `useSafeAreaInsets`) and set `options={{ title }}` so the header and notches render correctly.
6. Add a deep-link path under `linking.config.screens` if the screen should be reachable by URL, then test push + back + deep link on device.

## Rules
- Keep navigation param payloads small and serializable — pass IDs, not whole objects or functions.
- Don't call `navigation.navigate` during render; do it in an effect or an event handler.
- Use `useFocusEffect`/`useIsFocused` for work that should run when the screen gains focus, not `useEffect` alone.
- Type the param list once and reuse it everywhere to catch wrong-param navigations at compile time.
- Account for the header height and safe-area insets so content isn't clipped under the notch or status bar.
