---
name: wayfinder
description: Chart a fog-bound project as a map of open decisions, then resolve them one at a time across sessions
category: productivity
---

# Wayfinder

Use this when a project is too big for one session AND still too vague to plan — many unknowns and no clear route yet. It produces a map of decisions to answer, not a list of features to build. The map is a file, so the work survives the session that started it.

1. Write the destination in one sentence: the spec, decision, or change that would mean "done". If you cannot, that is the first thing to find out.
2. Sweep broadly for open decisions before going deep on any of them — read the code, the docs, the existing config. Depth this early buries the unknowns you have not met yet.
3. Create `docs/wayfinding.md` with four sections: **Destination**, **Decided**, **Open**, **Fog**.
4. Every question you can state precisely becomes a numbered entry under **Open**, each with a type (research / prototype / decide) and what would settle it. Anything you can only gesture at goes under **Fog** as a phrase — do not force it into a question yet.
5. Note which Open entries block which others; work only unblocked ones.
6. Take one entry. Resolve it with the right tool — `spike` for a timeboxed unknown, `adr` for a decision worth recording permanently, plain reading for the rest.
7. Move the answer to **Decided** with one line of reasoning. Delete the entry from **Open**.
8. Re-read **Fog**: an answer usually sharpens something vague enough to promote into a real Open entry. Move what has hardened.
9. Repeat from 5. Stop when **Open** and **Fog** are empty, or the route is clear enough to hand to a plan.

## Rules
- Plan, do not build. A wayfinding session that ships a feature has skipped its own purpose.
- One decision per entry. "Design the auth system" is a destination, not an entry.
- Only ticket what you can state precisely; vague items stay in Fog until an answer sharpens them. A badly-posed question wastes a whole session.
- Record the reasoning in Decided, not just the verdict — the next session is a stranger to it.
- The map file is the state. Update it as you go, never at the end; a session that dies mid-way must leave a resumable map.
- Nothing in Fog blocks progress. Work the unblocked Open entries and let Fog clear itself.
- Overkill for one feature with one unknown — use `spike` or `brainstorming` instead.
