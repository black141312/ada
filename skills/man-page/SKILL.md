---
name: man-page
description: Write a man page / CLI --help reference with synopsis, options, examples, and exit codes.
category: docs
---

# Man Page

Use when a CLI needs a precise reference — the canonical `--help` output and/or a `man` page that documents every flag, argument, and exit code.

1. Follow the standard section order: NAME, SYNOPSIS, DESCRIPTION, OPTIONS, EXAMPLES, EXIT STATUS, ENVIRONMENT, SEE ALSO.
2. Write the SYNOPSIS with convention: `[ ]` optional, `<>` placeholders, `...` repeatable, `|` mutually exclusive.
3. Document every option with both short and long forms (`-v, --verbose`), its argument, default, and one-line effect.
4. Add an EXAMPLES section with real, copy-pasteable invocations covering the common cases and one advanced case.
5. List exit codes and their meaning (0 success, non-zero failures) so scripts can branch on them.
6. Keep the in-binary `--help` and the man page consistent — ideally generate one from the other (e.g. from the arg parser).
7. Author the man page in Markdown and convert with `pandoc`/`ronn`/`scdoc` rather than hand-writing roff.

## Rules
- SYNOPSIS notation is a contract: optional/required/repeatable must match the parser's actual behavior.
- Document defaults and units explicitly (`--timeout <sec>` default `30`); ambiguity here causes real bugs.
- Examples are mandatory and must run as written — they're the section people actually read.
- Don't hand-edit roff; generate the man page from a readable source.
- Keep `--help` terse and the man page complete; cross-reference rather than duplicate.
