---
name: physics
description: Add basic collision detection and response for 2D/3D game entities
category: gamedev
---

# Physics

Reach for this to add movement, collision detection, and resolution without pulling in a full physics engine.

1. Choose collider shapes (AABB, circle/sphere, capsule) that fit your entities; prefer the simplest that works.
2. Integrate motion with semi-implicit Euler: `velocity += accel * dt; position += velocity * dt`.
3. Broad-phase first (spatial grid or sweep) to cull pairs, then narrow-phase exact overlap tests on survivors.
4. On overlap, compute penetration depth and a contact normal; separate by pushing along the normal.
5. Resolve velocity along the normal using restitution (bounce) and friction along the tangent.
6. Run collision after integration each fixed step; iterate resolution a few times for stacked contacts.

## Rules
- Run physics on the fixed timestep, not the render delta, so behavior is stable and reproducible.
- Use swept/continuous tests for fast objects to avoid tunneling through thin walls.
- Separate position correction from velocity response; resolving only velocity leaves objects sinking.
- Add a small slop/epsilon and skip resolving tiny penetrations to stop jitter at rest.
- Keep colliders convex; concave shapes need decomposition or you get caught-edge artifacts.
