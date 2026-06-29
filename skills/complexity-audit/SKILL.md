---
name: complexity-audit
description: Flag over-engineering and complexity hotspots in the diff and propose simpler shapes
category: review
---

# Complexity Audit

Reach for this when a change feels heavier than the problem warrants — too many layers, premature abstraction, or branching that's hard to hold in your head.

1. Read the diff and locate hotspots: deep nesting, long functions, many parameters, and high branch counts.
2. Flag speculative generality — abstractions, interfaces, config knobs, and plugin points with exactly one caller and no second on the horizon.
3. Look for reinvented standard-library or framework features and unnecessary dependencies that a few lines would replace.
4. Identify state that could be derived, indirection that adds no value, and special cases that a small reshape would collapse.
5. For each hotspot, propose the simplest shape that still meets the requirement, and estimate the lines/branches removed.
6. Apply the safe simplifications behind passing tests; leave larger refactors as concrete suggestions.

## Rules
- Optimize for the reader: fewer moving parts and shallower call stacks beat clever density.
- Apply YAGNI — delete flexibility added for a future that isn't on the roadmap.
- Don't trade real correctness or clarity for a lower line count; simpler must still be right.
- Reach for the standard library and native platform features before custom code or a new dependency.
- Confirm behavior is unchanged after each simplification by running the tests.
