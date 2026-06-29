---
name: explain-code
description: Explain an unfamiliar region of the codebase by reading it in context and summarizing intent and risks
category: code-understanding
---

# Explain Code

Reach for this when asked "what does this do?" about a file, function, or block you have not read yet. The goal is an accurate plain-language account, not a line-by-line restatement.

1. Read the whole unit (function/class/file), not just the lines pointed at — context above and below changes meaning.
2. Identify inputs, outputs, and side effects: what comes in, what goes out, what state or I/O it touches.
3. Resolve unfamiliar symbols by grepping their definition rather than guessing from the name.
4. Note the control flow: branches, loops, early returns, error/exception paths, and what triggers each.
5. State the purpose in one or two sentences, then explain the non-obvious parts (edge cases, why it exists, surprising behavior).
6. Flag anything risky or unclear: dead code, TODOs, implicit assumptions, or behavior that contradicts the names.

## Rules
- Explain intent and behavior, not syntax — assume the reader knows the language.
- Quote exact identifiers and file paths so the reader can navigate; never paraphrase a function name.
- If behavior depends on a caller or config you have not seen, say so instead of inventing it.
- Distinguish what the code does from what it appears intended to do when they diverge.
- Keep it proportional: a short helper gets a sentence, not a page.
