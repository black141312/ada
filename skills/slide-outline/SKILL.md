---
name: slide-outline
description: Outline a presentation as one idea per slide before building any actual slides.
category: pptx
---

# Slide Outline

Always reach for this before generating a deck. A tight outline prevents bloated, unfocused slides and makes the build step mechanical.

1. Pin down the single goal of the talk and the one action or belief you want the audience to leave with.
2. Identify the audience and time budget (roughly 1-2 minutes per content slide) to bound the slide count.
3. List each slide as a one-line takeaway headline — the assertion, not the topic ("Churn dropped 30% after onboarding redesign", not "Churn").
4. Under each headline note the supporting evidence: a stat, chart, image, or 2-3 bullets — nothing more.
5. Order for narrative flow (hook → context → core argument → evidence → call to action) and check each slide earns its place.
6. Review the outline with the user, then hand it to pptx-deck or pptx-from-markdown to build.

## Rules
- One idea per slide; if a headline contains "and", split it into two slides.
- Headlines are full assertions, not topic labels.
- Keep supporting points to 3 or fewer per slide at the outline stage.
- Cut any slide that doesn't advance the single goal.
- Settle structure and message in the outline; defer all visual styling to the build.
