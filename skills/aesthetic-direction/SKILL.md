---
name: aesthetic-direction
description: Choose an intentional, non-templated visual direction and reference before building any UI
category: ui-design
---

# Aesthetic Direction

Do this before writing component code. The difference between a forgettable, templated UI and a memorable one is a deliberate point of view chosen up front — not defaults stacked by accident.

1. Name the feeling in 2–3 adjectives and a reference: "editorial and confident, like Linear meets a print magazine" or "warm utilitarian, like a well-made tool." Vague intent yields vague output.
2. Pick a stance on each axis deliberately: density (airy vs. compact), shape language (sharp vs. rounded), contrast (muted vs. punchy), and ornament (flat vs. layered/textured). Write the choices down.
3. Choose ONE signature move the design hangs on — a distinctive typeface, a bold accent, a grain/noise texture, an unusual grid, a motion personality. Without a signature, it reads generic.
4. Anchor with real references: pull 3–5 screenshots you admire and articulate *what specifically* works (the oversized headers, the restrained palette, the tight grid) — then translate, don't copy.
5. Pressure-test against templates: if it could be any Bootstrap/default-shadcn site, push harder — change the type, break the symmetry, commit to one strong color, vary the rhythm.
6. Encode the direction into tokens immediately so the rest of the build inherits the decision instead of re-litigating it per component.
7. Sanity-check feasibility and accessibility — a daring direction still has to pass contrast and perform.

## Rules
- Decide the direction before components; retrofitting taste onto built UI rarely works.
- Commit to one signature element rather than three half-measures.
- "Modern/clean/minimal" is not a direction — name a feeling, a reference, and a specific move.
- Default shadcn/Bootstrap/Tailwind-gray is a starting point to subvert, not a destination.
- Distinctive still means accessible and fast — daring is not an excuse for 2:1 contrast.
