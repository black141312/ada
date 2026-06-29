---
name: bash-script
description: Write a robust, safe bash script with strict mode, quoting, traps, and clear failure handling
category: shell
---

# Bash Script

Use this when authoring a bash script that must run reliably and fail loudly — automation, glue, CI steps, or setup scripts.

1. Start with `#!/usr/bin/env bash` and `set -euo pipefail` so unset vars, failed commands, and broken pipes abort the run.
2. Set `IFS=$'\n\t'` if you iterate over lines/paths, and quote every expansion (`"$var"`, `"${arr[@]}"`) to survive spaces and globs.
3. Wrap logic in functions with a `main "$@"` entrypoint at the bottom; keep top-level code to argument parsing and the `main` call.
4. Add `trap 'cleanup' EXIT` (and `ERR` if useful) to remove temp files made with `mktemp`, even on early exit.
5. Validate prerequisites up front: required args, `command -v tool` for each dependency, and writable paths — exit with a message before doing work.
6. Run `shellcheck` on the script and fix every warning before considering it done.

## Rules
- Never `cd` without checking it succeeded; prefer `cd "$dir" || exit 1` or compute absolute paths instead.
- Avoid parsing `ls` output; use globs or `find ... -print0` with `read -d ''` for filenames.
- Send errors and progress to stderr (`>&2`); keep stdout for the script's actual output.
- Use `[[ ]]` over `[ ]` for tests, and `$(...)` over backticks for command substitution.
- For anything with nested data structures, arrays of structs, or heavy text processing, stop and switch to Python — bash is the wrong tool past ~100 lines.
