---
name: speaker-notes
description: Write per-slide speaker notes that a presenter can deliver, added to each slide's notes pane.
category: pptx
---

# Speaker Notes

Use when a deck needs a spoken script or presenter guidance — slides carry the headline, notes carry what the presenter actually says.

1. Read each slide's headline and visuals to understand the point that slide must land.
2. Write the notes as spoken language: the opening line, the key point, and a transition into the next slide.
3. Keep each slide's notes to roughly 30-90 seconds of speech (about 75-200 words); trim anything the slide already shows.
4. Add timing cues, the "so what" for any chart, and reminders for demos or audience questions.
5. Write notes into `slide.notes_slide.notes_text_frame.text` in python-pptx (this auto-creates the notes slide).
6. Read the notes end-to-end as a continuous script to check the narrative flows between slides.

## Rules
- Notes are a script to speak, not bullet points to read aloud — write in full, natural sentences.
- Never just restate the slide text; add the context, story, or data interpretation behind it.
- Match the speaker's voice and the talk's time budget; cut ruthlessly if over.
- Always end a slide's notes with a one-line bridge to the next slide.
- Flag any claim that needs a source or a number the presenter must confirm.
