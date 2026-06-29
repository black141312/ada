---
name: pitch-deck
description: Build a startup/investor pitch deck covering problem, solution, market, traction, and the ask.
category: pptx
---

# Pitch Deck

Use when the user needs an investor or fundraising pitch deck. Follow the canonical 10-12 slide arc and keep every slide skimmable in seconds.

1. Gather the essentials: one-line value prop, target customer, business model, traction numbers, team, and the funding ask.
2. Order the slides: Title → Problem → Solution → Product → Market (TAM/SAM/SOM) → Business Model → Traction → Competition → Team → Ask/Use of Funds (optional: Roadmap, Vision close).
3. Draft one sharp headline per slide that states the takeaway, then support it with at most 3 bullets or one visual.
4. Make Traction and Market concrete with real numbers and charts (revenue, growth, users); route data viz through slide-charts.
5. State the Ask explicitly: amount raising, round type, and use of funds breakdown.
6. Build the file via the pptx-deck skill (python-pptx) or pptx-from-markdown, then apply a clean branded theme (pptx-template).

## Rules
- Lead each slide with the conclusion; investors skim, they don't read.
- Numbers over adjectives — "$40k MRR, 22% MoM" beats "rapid growth".
- One message per slide; if a slide needs two charts to explain, split it.
- TAM/SAM/SOM must be bottoms-up and defensible, not a giant top-down number.
- Keep it to ~12 slides; push deep detail (financial model, full metrics) into an appendix.
- Never invent traction, customers, or financials — flag any gaps for the user to fill.
