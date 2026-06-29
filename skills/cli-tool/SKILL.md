---
name: cli-tool
description: Scaffold a command-line tool with subcommands, flags, and help using clap, commander, or argparse
category: shell
---

# CLI Tool

Reach for this when building a new command-line program that parses arguments, exposes subcommands, and prints help — in Rust (clap), Node (commander/yargs), or Python (argparse/click).

1. Pick the language's standard parser: Rust → `clap` (derive feature), Node → `commander`, Python → `argparse` (stdlib) or `click` if you need rich UX.
2. Define the command surface first: the binary name, each subcommand, positional args, and flags with short/long forms and defaults — write it down before coding.
3. Generate `--help`/`--version` automatically from the parser; never hand-roll usage strings that can drift from the actual options.
4. Read input, do the work, and write results to stdout; send logs, prompts, and errors to stderr so output stays pipeable.
5. Return a nonzero exit code on failure (`std::process::exit`, `process.exitCode`, `sys.exit(1)`) and map distinct failure classes to distinct codes if callers will branch on them.
6. Add a smoke test that invokes the binary with `--help` and one real subcommand, asserting exit code and key output lines.

## Rules
- Parse args at the boundary only; pass plain typed values into your core functions so logic stays testable without the CLI.
- Respect `NO_COLOR` and detect non-TTY stdout (`isatty`) before emitting colors or progress bars.
- Validate and fail fast on bad input with a clear message and usage hint — don't proceed with defaults that hide the error.
- Read secrets from env vars or files, never from positional args (they leak into shell history and `ps`).
- Keep stdout machine-parseable; offer `--json` or `--quiet` if output is consumed by other tools.
