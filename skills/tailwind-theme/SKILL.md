---
name: tailwind-theme
description: Set up Tailwind with a custom token-driven theme so utilities map to your design system, not defaults
category: ui-design
---

# Tailwind Theme

Use this when a Tailwind project still looks like stock Tailwind — default grays, `blue-500`, `shadow-md` everywhere. The fix is wiring Tailwind to your tokens so utility classes carry your brand.

1. Define your palette/space/type/radius as CSS custom properties on `:root` (and a dark override), then point Tailwind at them. In v4, do this in CSS via `@theme { --color-accent: …; --radius-lg: …; }`.
2. Map semantic names into the theme: `bg-surface`, `text-muted`, `border-subtle`, `bg-accent` — so markup reads by role and a re-theme is a token edit, not a find-replace across components.
3. Replace, don't extend-and-ignore, the defaults you won't use: prune the stock gray ramp and arbitrary blues so nobody reaches for `text-gray-500` and bypasses your system.
4. Set a real type scale and `fontFamily` from your fonts; configure `--leading-*` and `--tracking-*` so `text-2xl` etc. carry intentional line-height, not Tailwind's generic defaults.
5. Build repeated patterns as components (React/Astro/Svelte) or `@apply` recipes for true primitives (`.btn`), not by copy-pasting 14 utility classes per button.
6. Lean on Tailwind's modern features intentionally: container queries (`@container`), `data-*`/`aria-*` variants for state, and the `dark:` variant driven by your `[data-theme]` strategy.
7. Add `prettier-plugin-tailwindcss` for canonical class order and an ESLint rule to flag arbitrary values (`w-[13px]`) that signal an off-system value.

## Rules
- Utilities must resolve to your tokens; if `bg-accent` doesn't exist, the theme isn't wired up.
- Prune unused default colors so the stock palette can't be used by accident.
- Extract a component or `@apply` recipe once a class string repeats; don't shotgun utilities.
- Arbitrary values (`p-[13px]`, `text-[#3a3a3a]`) are escape hatches — flag and minimize them.
- Drive `dark:` from the same token strategy as the rest of the system, not a separate color set.
