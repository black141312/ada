---
name: scroll-animation
description: Build scroll-triggered and scroll-linked animations (GSAP/Framer Motion) that stay smooth and jank-free.
category: ui-design
---

# Scroll Animation

Reach for this when content should reveal, pin, or parallax as the user scrolls — done well it adds depth; done badly it stutters and hijacks the page.

1. Decide trigger vs. scrub: reveal-on-enter (fire once when in view) vs. scroll-linked (progress tied to scroll position). Most sections want reveal; reserve scrubbing for hero/storytelling.
2. For reveals, prefer the native `IntersectionObserver` (or Framer Motion `whileInView` with `viewport={{ once: true }}`) — cheap and battery-friendly. Add a `rootMargin` so it triggers slightly before the element hits the fold.
3. For scrubbed/pinned sequences use GSAP ScrollTrigger with `scrub: true` (or a small smoothing number); animate only `transform`/`opacity` and let GSAP batch reads/writes.
4. Build the parallax/depth illusion with differential `translateY` on layers via transform — never animate `background-position` or `top` during scroll.
5. Stagger grouped reveals (40–80ms) and keep per-element distance small (16–40px rise) — large travel reads as laggy and forces reflow into view.
6. Disable scroll effects (or make them instant) under `prefers-reduced-motion`, and lazy-init heavy ScrollTriggers below the fold so first paint stays fast.

## Rules
- Never block or rubber-band native scroll; smooth-scroll libraries (Lenis) are opt-in and must respect reduced-motion.
- Keep work off the scroll thread: no layout-triggering properties, no `getBoundingClientRect` per frame in your own handlers — let IO/ScrollTrigger do it.
- Content must be fully readable with JS disabled or before the observer fires — start visible, animate enhancement, never hide-until-scripted as the only path.
- Test on a mid-tier phone at 60fps; if you see dropped frames, reduce simultaneous animated elements before tweaking easing.
- `will-change: transform` only on elements actively animating, and remove it after — leaving it on bloats the compositor.
