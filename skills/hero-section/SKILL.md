---
name: hero-section
description: Design a striking, conversion-focused hero with one clear message, sharp hierarchy, and a single CTA.
category: ui-design
---

# Hero Section

Reach for this for the first screen of a landing page — the hero has ~3 seconds to land the value proposition and drive one action.

1. Lock the message architecture: one eyebrow/kicker (optional), one headline stating the outcome (not the feature), one subhead clarifying, one primary CTA. Cut everything else.
2. Build a real type scale with `clamp()` — e.g. headline `clamp(2.5rem, 5vw + 1rem, 5rem)`, tight `line-height: 1.05`, and `letter-spacing: -0.02em` on large display text for an editorial feel.
3. Establish hierarchy through contrast, not just size: the CTA is the highest-contrast element on screen; the subhead sits in a muted foreground; supporting visuals never out-shout the headline.
4. Give it breathing room — generous vertical rhythm on an 8px scale, a constrained measure (~60ch) on the subhead, and asymmetry (off-center text + image) to avoid a sterile centered template.
5. Add one tasteful motion beat on load: staggered fade-rise of headline → subhead → CTA (40–60ms apart, ease-out, ≤400ms total). Subtle, once, never looping.
6. Engineer for performance and LCP: the headline is real text (not an image), hero media is `priority`/preloaded and properly sized, and the layout is reserved to prevent CLS.

## Rules
- One primary CTA. A secondary "Learn more" can exist as a quieter ghost/text link, never a competing button.
- The headline sells the outcome to the user; if it could appear on a competitor's site verbatim, rewrite it.
- Maintain ≥4.5:1 contrast for headline text over any image/gradient — add a scrim or duotone rather than risk legibility.
- Don't center everything by reflex; intentional asymmetry and a strong grid read as designed, not default.
- Hero must be legible and complete above the fold on a 360px phone before you polish desktop.
