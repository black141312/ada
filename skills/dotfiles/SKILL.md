---
name: dotfiles
description: Manage dotfiles and machine setup as a version-controlled, reproducible, idempotent install
category: shell
---

# Dotfiles

Reach for this when organizing shell/editor/tool config into a repo that bootstraps a new machine the same way every time.

1. Put all configs in one git repo and link them into place with symlinks (or GNU `stow`) so edits in the repo are live immediately.
2. Write an idempotent `install.sh` that creates symlinks, backs up any pre-existing real file to `*.bak`, and can be re-run safely without clobbering.
3. Separate machine-specific or secret values (tokens, work-vs-personal email) into a gitignored `*.local` file that the tracked config sources at the end.
4. Pin tool installs explicitly — a `Brewfile`, `apt` list, or `mise`/`asdf` `.tool-versions` — so package state is reproducible, not implicit.
5. Make config files host-aware via conditionals (`$(hostname)`, OS check) rather than maintaining divergent copies per machine.
6. Test the bootstrap on a clean container or VM, then document the one-liner to clone and run `install.sh` in the README.

## Rules
- Never commit secrets, SSH private keys, or API tokens; gitignore `*.local`, `.env`, and key files, and scan history before pushing.
- Keep `install.sh` idempotent — running it twice must be a no-op, not a pile of duplicate symlinks or appended lines.
- Back up existing files before symlinking so a first run on a populated home dir doesn't destroy data.
- Prefer symlinks over copies so the repo stays the single source of truth.
- Guard OS-specific blocks (`case "$(uname -s)"`) so the same repo works on macOS and Linux.
