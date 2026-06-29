---
name: extract-function
description: Pull a cohesive block of code into a well-named function or method
category: refactoring
---

# Extract Function

Use when a function is too long, a block needs a comment to explain it, or the same logic is about to be reused. A good extraction names the "what" so the caller reads like prose.

1. Identify the exact block to extract and confirm it is cohesive (one job, clear boundary).
2. Determine inputs (variables read) and outputs (variables written/returned after the block).
3. Create the new function with those inputs as parameters and the outputs as return value(s).
4. Replace the original block with a call; pass arguments and assign results back.
5. Name the function for its intent, not its mechanics (`computeTax`, not `doStep2`).
6. Run tests; the behavior and outputs must be identical.

## Rules
- If the block writes more than one or two outer variables, return a small object/tuple instead of using side effects.
- Keep the new function pure when feasible — pass dependencies in rather than reaching for globals.
- Don't over-parameterize; if a value is constant at the call site, inline it.
- Place the new function at a sensible scope (same module/class) before reaching for shared utils.
- Preserve early returns and error paths exactly; extracting can silently swallow a `return`.
