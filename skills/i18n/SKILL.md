---
name: i18n
description: Extract hardcoded strings and set up internationalization with locale-aware formatting
category: frontend
---

# I18n

Use when preparing an app for multiple languages: pulling hardcoded copy into message catalogs and wiring up locale switching and formatting.

1. Pick or confirm the i18n library that fits the framework (e.g. i18next, react-intl, next-intl, vue-i18n) and set a default locale plus a fallback.
2. Sweep the UI for user-facing strings and replace each with a translation call keyed by a stable, namespaced id (e.g. `cart.checkout.button`), not the English text.
3. Externalize all strings into per-locale catalog files; seed the default locale and leave other locales as keys to be translated.
4. Handle plurals, gender, and variables through the library's interpolation/ICU features — never build sentences by string concatenation.
5. Use locale-aware formatting (`Intl.NumberFormat`, `Intl.DateTimeFormat`, currency, relative time) for all numbers, dates, and money instead of manual formatting.
6. Wire a locale provider/switcher, persist the choice, set `<html lang>`/`dir` (including RTL), and lazy-load the active locale's catalog.

## Rules
- Never concatenate translated fragments; pass variables into a single parameterized message.
- Use stable semantic keys, not English copy, as ids so wording changes don't break lookups.
- Keep pluralization in the catalog (ICU/plural rules), not in component conditionals.
- Format every date, number, and currency via `Intl`/the i18n layer, never hand-rolled.
- Support RTL: set `dir`, avoid left/right-only CSS, and prefer logical properties (`margin-inline-start`).
