---
name: web-component
description: Build a reusable custom element with Shadow DOM, attributes/properties, slots, and events using web standards.
category: html
---

# Web Component

Use when you need a framework-agnostic, encapsulated UI element (design-system widget, embeddable badge) that works in any page or framework.

1. Define a class extending `HTMLElement`, register it with `customElements.define('my-thing', MyThing)`, and use a hyphenated name (required for custom elements).
2. Attach Shadow DOM in the constructor (`this.attachShadow({mode:'open'})`) so styles and markup are encapsulated and don't leak in or out.
3. Render markup + scoped `<style>` into the shadow root; expose insertion points with `<slot>` (and named slots) for light-DOM content.
4. Wire reactivity: list reflected attributes in `static observedAttributes`, react in `attributeChangedCallback`, and mirror important attrs to properties (getters/setters).
5. Manage lifecycle in `connectedCallback`/`disconnectedCallback` — add listeners on connect, remove on disconnect to avoid leaks.
6. Communicate outward with `dispatchEvent(new CustomEvent('change',{detail,bubbles:true,composed:true}))` so events cross the shadow boundary; expose theming via CSS custom properties and `::part()`.

## Rules
- Tag names must contain a hyphen and be unique; registering the same name twice throws.
- Don't touch the DOM in the constructor (element may not be connected) — defer to `connectedCallback`.
- Use `composed:true` on CustomEvents that must escape the shadow root, and `bubbles:true` to propagate.
- Expose styling hooks via CSS custom properties / `::part()`; consumers can't reach inside closed Shadow DOM otherwise.
- Always remove event listeners and observers in `disconnectedCallback` to prevent memory leaks.
