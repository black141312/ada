---
name: tui-app
description: Build a terminal UI app with a render loop, input handling, and clean teardown using ratatui, ink, or textual
category: shell
---

# TUI App

Reach for this when building an interactive full-screen terminal application — dashboards, pickers, file browsers — with keyboard navigation and live updates.

1. Pick a framework: Rust → `ratatui` + `crossterm`, Node → `ink` (React-style), Python → `textual` or `urwid`.
2. Model state explicitly (a single app struct/store) and render the whole UI as a pure function of that state each frame — never mutate widgets imperatively from scattered handlers.
3. Run an event loop that blocks on input/timer events, updates state, then redraws; keep heavy or blocking work (I/O, network) off the UI thread via async tasks or a worker channel.
4. On startup enter raw mode and the alternate screen; on exit — including panics and Ctrl-C — restore the terminal so the user's shell isn't left corrupted.
5. Handle resize events and recompute layout; never hardcode width/height, and degrade gracefully on tiny terminals.
6. Provide clear key hints and a quit binding (`q`/Ctrl-C), and test the render-from-state logic without a real TTY.

## Rules
- Always restore the terminal on exit: wrap teardown in a guard/`defer`/panic hook so a crash mid-frame doesn't leave a broken shell.
- Keep the event loop non-blocking; spawn long tasks elsewhere and feed results back as events, or the UI freezes.
- Throttle redraws (only on state change or a frame tick) instead of busy-looping the CPU at full speed.
- Don't print to stdout/stderr while in alternate-screen mode — it scrambles the display; route logs to a file.
- Make every action keyboard-reachable and show the active keymap; assume no mouse.
