---
name: pr-review
description: Review a GitHub PR with gh, summarize the change, and suggest concrete improvements
category: git
---

# PR Review

Reach for this when asked to review a GitHub pull request: understand the intent, read the diff, and leave actionable feedback rather than a rubber stamp.

1. Fetch context: `gh pr view <num>` for title/body/checks, and `gh pr view <num> --comments` to read existing discussion so you don't repeat points.
2. Read the actual change: `gh pr diff <num>` (add `--patch | less` for large diffs). Note the base branch and files touched.
3. Check CI/state: `gh pr checks <num>` — flag failing checks before reviewing logic, since they may make the review moot.
4. Walk the diff hunk by hunk: trace data flow, look for missing error handling, untested edge cases, security/auth gaps, and behavior that contradicts the PR description.
5. Separate findings into blocking (correctness, security, breaking) vs non-blocking (style, naming, nits) so the author knows what must change.
6. Summarize: one-paragraph overview of what the PR does, then a bulleted list of suggestions, each anchored to `file:line`.
7. If asked to post, use `gh pr review <num> --comment -b "..."` or `--approve`/`--request-changes`; for line-specific notes use `gh pr comment` or the review API.

## Rules
- Review the diff, not your assumptions — pull the branch (`gh pr checkout <num>`) if you need to run or grep the code.
- Quote `file:line` for every concrete suggestion; vague feedback like "improve error handling" is not actionable.
- Don't approve a PR with failing required checks or unresolved blocking comments.
- Keep tone constructive and specific; flag, don't rewrite, unless the author asked for code.
- Respect scope: note out-of-scope issues separately rather than blocking the PR on them.
