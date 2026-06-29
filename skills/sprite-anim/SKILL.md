---
name: sprite-anim
description: Build a frame-based sprite animation system driven by a texture atlas
category: gamedev
---

# Sprite Animation

Use to play named animation clips (idle, run, attack) from a sprite sheet with correct timing and state transitions.

1. Pack frames into an atlas and record each frame's source rect (x, y, w, h) plus pivot/origin.
2. Define clips as ordered frame lists with per-clip frame duration (or per-frame durations) and a loop flag.
3. Track playback state per entity: current clip, elapsed time, current frame index, playing/paused.
4. Each update, advance elapsed by `dt`; while it exceeds the frame duration, subtract and step the frame index.
5. At clip end, loop back to frame 0 or hold the last frame and fire an "animation finished" event.
6. On render, draw the current frame's source rect to the destination, honoring the pivot for flips and rotation.

## Rules
- Drive timing by accumulated `dt`, never by frame count, so speed is constant across frame rates.
- Keep animation state separate from gameplay state; a state machine decides which clip, the player just plays it.
- Use the pivot/origin for horizontal flips so the sprite does not visually jump on direction change.
- Disable texture filtering (use nearest) for pixel art to avoid bleeding between atlas frames; add padding/extrusion.
- Make non-looping clips emit a completion signal so transitions (attack→idle) are event-driven, not polled.
