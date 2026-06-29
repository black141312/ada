---
name: shader
description: Write and wire up a GLSL or WGSL shader with correct varyings and uniforms
category: gamedev
---

# Shader

Use when authoring a vertex/fragment (or compute) shader and binding it to geometry, uniforms, and textures.

1. Decide the stage and language target (GLSL ES 3.0, GLSL 4.x core, or WGSL) and match it to your graphics API.
2. Declare inputs explicitly: vertex attributes by location, varyings (`out`/`in`) matching between stages by name and type.
3. Pass per-draw data via uniforms / uniform buffers / push constants; keep the layout in sync with host-side structs.
4. In the vertex stage output clip-space position; in the fragment stage compute color, sampling textures with a bound sampler.
5. Compile and check the info log; fail loudly on shader compile and program link errors before first draw.
6. Verify output with a flat color or UV-visualization pass before adding lighting or effects.

## Rules
- Varying names and types must match exactly across vertex→fragment, or linking silently mismatches.
- Watch precision qualifiers in GLSL ES (`highp`/`mediump`) — defaults differ between desktop and mobile.
- Respect uniform buffer std140/std430 alignment; a `vec3` is padded to 16 bytes and will corrupt later fields.
- Y axis and clip-space depth range differ between OpenGL, Vulkan/WGSL, and D3D — flip UVs/viewport as needed.
- Avoid dynamic branching and unbounded loops in fragment shaders on mobile GPUs; prefer `mix`/`step`.
