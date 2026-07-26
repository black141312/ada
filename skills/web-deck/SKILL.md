---
name: web-deck
description: Build a presentation, talk, pitch, slides or walkthrough as a slidable HTML deck - arrow-key navigation, one slide per screen, prints to PDF - instead of one long scrolling page.
category: html
---

# Web Deck

Use with `create_page` when the deliverable is a **presentation** rather than a document. A deck is
not a long page with headings: one idea fills the screen, and the reader advances it.

Reach for this when the user said presentation, deck, slides, talk, pitch or walkthrough and chose
HTML over `.pptx`. For a report, dashboard or one-pager, use the **web-page** skill instead - those
are meant to be scrolled.

## The scaffold

Start from this. It is complete and tested: arrow keys, Space, PageUp/PageDown, Home/End, click to
advance, a counter, a progress bar, deep links (`#3` opens slide 3, browser back/forward work), and
a print rule so each slide becomes its own PDF page. Replace the `<section class="slide">` blocks
with the real content and restyle the tokens; leave the mechanics alone.

```html
<div class="deck">
  <section class="slide on">…slide 1…</section>
  <section class="slide">…slide 2…</section>
</div>
<div class="bar"><span id="bar"></span></div>
<div class="count" id="count"></div>
```

```css
.deck {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.slide {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
  padding: clamp(32px, 7vw, 96px);
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.28s ease,
    visibility 0.28s;
}
.slide.on {
  opacity: 1;
  visibility: visible;
}
@media (prefers-reduced-motion: reduce) {
  .slide {
    transition: none;
  }
}
/* type scales with the viewport - a deck is read from across a room, not at 16px */
h1 {
  font-size: clamp(30px, 5.2vw, 68px);
  line-height: 1.05;
  text-wrap: balance;
}
h2 {
  font-size: clamp(24px, 3.6vw, 44px);
  line-height: 1.1;
  text-wrap: balance;
}
p,
li {
  font-size: clamp(15px, 1.6vw, 21px);
  max-width: 60ch;
}
.bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: #8883;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.28s ease;
}
.count {
  position: fixed;
  right: clamp(16px, 3vw, 36px);
  bottom: clamp(14px, 2.4vw, 28px);
  font: 12px var(--mono);
  font-variant-numeric: tabular-nums;
}
/* without this every slide stacks onto page one */
@media print {
  .deck {
    height: auto;
    overflow: visible;
  }
  .slide {
    position: static;
    opacity: 1;
    visibility: visible;
    height: 100vh;
    break-after: page;
  }
  .bar,
  .count {
    display: none;
  }
}
```

```js
const slides = [...document.querySelectorAll(".slide")];
let i = 0;
function go(n) {
  i = Math.max(0, Math.min(slides.length - 1, n)); // clamp at both ends
  slides.forEach((s, k) => {
    s.classList.toggle("on", k === i);
    s.setAttribute("aria-hidden", k === i ? "false" : "true"); // hidden slides aren't read aloud
  });
  count.textContent =
    String(i + 1).padStart(2, "0") +
    " / " +
    String(slides.length).padStart(2, "0");
  bar.style.width = ((i + 1) / slides.length) * 100 + "%";
  location.hash = i + 1;
}
addEventListener("keydown", (e) => {
  const k = e.key;
  if (k === "ArrowRight" || k === "PageDown" || k === " ") {
    e.preventDefault();
    go(i + 1);
  } else if (k === "ArrowLeft" || k === "PageUp") {
    e.preventDefault();
    go(i - 1);
  } else if (k === "Home") {
    e.preventDefault();
    go(0);
  } else if (k === "End") {
    e.preventDefault();
    go(slides.length - 1);
  }
});
addEventListener("click", (e) => {
  if (!e.target.closest("a,button,input")) go(i + 1);
});
addEventListener("hashchange", () =>
  go((parseInt(location.hash.slice(1), 10) || 1) - 1),
);
go((parseInt(location.hash.slice(1), 10) || 1) - 1);
```

## Writing the deck

1. **One idea per slide.** If a slide needs two sentences to state its point, it is two slides.
2. **The heading carries the point**, not the bullets. "Costs 3x less" beats "Cost analysis".
3. **Six lines maximum**, and never a paragraph. Detail belongs in the talk, not on the wall.
4. **Open with the thesis**, close with what the reader should do or remember.
5. A number that matters gets a slide to itself, set large.
6. 8-14 slides for a project overview. More than ~20 means the deck is really a document.

## The four that get forgotten

Rewriting the scaffold in your own idiom is fine. These four are the ones that get quietly dropped
when you do, so write them deliberately rather than checking for them afterwards:

1. **`aria-hidden="true"` on every inactive slide.** Without it a screen reader reads all twelve
   slides as one wall of text. Setting it in `go()` costs one line.
2. **Deep links.** `location.hash = i + 1` when moving, and a `hashchange` listener. This is what
   makes `#7` shareable and browser Back behave.
3. **Clamp, don't wrap.** `Math.max(0, Math.min(last, n))` - a deck that loops from the last slide
   to the first is disorienting mid-talk.
4. **The `@media print` rule.** Without it every slide stacks onto page one and "print to PDF" is
   useless.

## Rules

- Every slide must fit 1280x720 without scrolling. Overflow doesn't track word count - a short slide
  with a big heading overflows where a long bulleted one doesn't - so judge it by the layout you
  chose, and when in doubt split the slide rather than shrinking the type.
- Still self-contained: no CDN, no webfonts (see the **web-page** skill).
- Opening it and pressing through every slide is the only way to be sure it renders. Worth doing
  when the deck matters or the user asks; it costs an extra round-trip, so it isn't automatic.
