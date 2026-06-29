---
name: diff-explain
description: Explain what a diff changes and why, summarizing intent, behavior shifts, and risks for a reviewer
category: code-understanding
---

# Diff Explain

Use to summarize a commit, PR, or working diff for a reviewer — what changed, why, and what to watch for — without restating every line.

1. Get the diff and its context: `git diff`, `git show <ref>`, or `gh pr diff`, plus the commit message or PR description for stated intent.
2. Group the hunks by purpose (feature, refactor, fix, test, config) rather than walking files top to bottom.
3. For each group, state the behavior change — what the code does differently now, not which lines moved.
4. Separate functional changes from no-op churn (renames, formatting, moves) so reviewers focus on what matters.
5. Identify risks: edge cases, removed checks, changed defaults, API/signature changes, and missing or weakened tests.
6. Summarize as intent + behavior delta + risks, and note whether the diff matches its stated purpose.

## Rules
- Explain effect, not mechanics — "now rejects empty input" beats "added an if on line 40".
- Flag scope creep: changes unrelated to the stated intent deserve a callout.
- Pay attention to deletions and weakened conditions; removed guards are easy to miss and often the bug.
- Note untested behavior changes and any public-interface or migration impact explicitly.
- If the diff's intent is unclear from the code and message, say so rather than inventing a rationale.
