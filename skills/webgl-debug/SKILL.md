---
name: webgl-debug
description: Debug WebGL/GPU rendering: blank canvas, context loss, bad buffers/attributes, silent draw-call failures
category: graphics
---

# WebGL Debug

Reach for this when a WebGL scene renders black, flickers, or draws nothing despite "no errors" — the API fails silently, so you must instrument it.

1. Check the context exists and isn't lost: confirm `gl = canvas.getContext('webgl2'||'webgl')` is non-null and listen for `webglcontextlost`. A null context usually means a prior context leak or an unsupported feature.
2. Add `gl.getError()` after every meaningful call during bring-up (or wrap with a debug proxy). Hunt the first non-`NO_ERROR`; `INVALID_OPERATION` after a draw call almost always means an unbound buffer or mismatched attribute.
3. Verify program linkage: check `gl.getProgramParameter(prog, gl.LINK_STATUS)` and `getShaderParameter(...COMPILE_STATUS)`, and print `getProgramInfoLog`/`getShaderInfoLog` — compile errors are otherwise swallowed.
4. Audit the draw-call preconditions: program `useProgram`'d, VAO/attributes enabled with correct stride/offset/type, uniforms set after `useProgram`, viewport set via `gl.viewport(0,0,w,h)`, and the buffer actually has data (`bufferData` length > 0).
5. Isolate: clear to a bright color (`clearColor(1,0,1,1); clear(...)`). If you don't even see magenta, it's context/viewport/canvas sizing — not your geometry.
6. For black geometry that's clearly drawing, suspect depth test (everything failing depth, near/far swapped), culling (`CULL_FACE` with reversed winding), or NaN in the MVP matrix collapsing all verts to one point.

## Rules
- Set uniforms and bind textures only AFTER `gl.useProgram`; before that they target the wrong/no program.
- `gl.viewport` does not auto-update on canvas resize — set it whenever the drawing buffer size changes.
- Always handle `webglcontextlost`/`restored`; GPU resets (tab background, driver hiccup) invalidate all buffers and textures.
- Attribute `stride`/`offset` are in bytes; getting the type or stride wrong reads garbage with no error.
- Use a magenta clear as the canary — it instantly separates "nothing draws" from "geometry is wrong".
