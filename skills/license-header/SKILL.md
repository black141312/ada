---
name: license-header
description: Add SPDX or license headers to source files consistently across the repo
category: compliance
---

# License Header

Reach for this when source files lack a license/copyright notice, or when adopting SPDX identifiers for tooling and audits.

1. Pick the license and confirm it matches the repo `LICENSE` file (e.g. MIT, Apache-2.0); use the exact SPDX identifier from spdx.org/licenses.
2. Decide the header form: short SPDX tag (`SPDX-License-Identifier: MIT`) plus a copyright line, or the full notice if the license requires it (Apache-2.0, GPL).
3. Map comment syntax per language (`//` for C/Go/JS/Rust, `#` for Python/shell/YAML, `<!-- -->` for HTML/XML) and place the header as the first lines, after a shebang or encoding line if present.
4. Apply to all in-scope files, skipping vendored/`node_modules`/generated code and anything with a conflicting third-party header.
5. Run a check that every target file starts with the header (grep the first lines) and fix misses.
6. Add or update a CI step (e.g. `licensee`, `reuse lint`, or a grep guard) so new files must include the header.

## Rules
- Never overwrite or remove an existing third-party copyright line; preserve it and add yours below.
- Keep the year/owner consistent with `LICENSE`; do not invent dates or change ownership.
- Respect shebangs: header goes on line 2+ so `#!/usr/bin/env` stays line 1 and the file stays executable.
- Prefer SPDX identifiers over pasting full license text in every file unless the license mandates the full notice.
- Match the project's existing comment style and spacing; do not reflow surrounding code.
