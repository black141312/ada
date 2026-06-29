---
name: rust-unsafe-audit
description: Review Rust unsafe blocks for soundness and document the invariants they rely on
category: languages
---

# Rust Unsafe Audit

Use this when auditing `unsafe` code for undefined behavior — raw pointer derefs, FFI, transmutes, or hand-rolled data structures.

1. Enumerate every `unsafe` block and the specific operation each performs (raw deref, `transmute`, `from_raw`, `get_unchecked`, FFI call) — group by the invariant each requires.
2. For each block, write down the safety contract: what must be true (non-null, aligned, valid for the access, unique/aliasing rules, initialized, lifetime outlives use) and confirm a caller or surrounding code guarantees it.
3. Add a `// SAFETY:` comment to every `unsafe` block stating why the invariants hold; if you can't write one, the code is suspect.
4. Check the aliasing rules specifically: no two `&mut` to the same data, no `&` overlapping a `&mut`, and pointers derived correctly (no provenance violations).
5. Run `cargo +nightly miri test` and `cargo test` under ASan/`-Zsanitizer` where possible to catch UB the compiler can't see; fuzz boundary inputs for FFI.
6. Minimize the unsafe surface: shrink blocks to the exact unsafe operation, wrap them in a safe abstraction with checked preconditions, and prefer safe std APIs where they exist.

## Rules
- Every `unsafe` block needs a `// SAFETY:` comment naming the upheld invariant — no exceptions, including in tests.
- `transmute` is the most dangerous tool here; prefer `as` casts, `from_le_bytes`, `bytemuck`, or explicit `union` access, and verify size/layout/`#[repr]`.
- A safe public function wrapping unsafe internals must uphold the contract for all possible inputs — validate before the unsafe op, not after.
- Miri-clean is not proof of soundness, but Miri-dirty is proof of a bug — never ship code Miri flags.
- Don't widen lifetimes or fabricate `&mut` from `&` to dodge the borrow checker; that's instant UB even if it compiles.
