---
name: rust-borrow
description: Diagnose and fix Rust borrow-checker and lifetime errors without resorting to clone-everything
category: languages
---

# Rust Borrow

Use this when `cargo build` rejects code with E0499/E0502/E0515/E0597 or lifetime mismatches and you want a clean fix, not a clone band-aid.

1. Read the error code and the borrow spans: the compiler points at where a value is borrowed, where it's used, and where the conflict happens — note the lifetimes involved.
2. For "cannot borrow as mutable while borrowed as immutable", shorten the immutable borrow's scope (let it end before the mutation) or split into separate statements so NLL can release it.
3. For "returns a value referencing data owned by the current function" (E0515), return an owned type (`String`, `Vec<T>`) or restructure so the caller owns the data.
4. Resolve aliasing conflicts by splitting borrows: use `split_at_mut`, indices instead of references, or restructure into smaller functions that borrow disjoint fields.
5. Add explicit lifetime parameters only when the compiler can't infer them; tie output lifetimes to the correct input, and prefer `'_` elision where it applies.
6. When shared ownership is genuinely needed, reach for `Rc`/`Arc` (+ `RefCell`/`Mutex` for interior mutability) — deliberately, not reflexively.

## Rules
- `.clone()` to silence the borrow checker is a smell; use it only when the copy cost is acceptable and ownership truly must split — otherwise restructure.
- Prefer narrowing scopes and splitting borrows over adding lifetime annotations; most errors are scope problems, not lifetime problems.
- Don't reach for `unsafe` to bypass the checker — it converts a compile error into undefined behavior.
- Avoid `Rc<RefCell<...>>` as a default; it moves borrow errors to runtime panics. Use it only when the ownership graph is genuinely shared.
- Keep functions small — many borrow conflicts dissolve when you extract code so borrows don't overlap.
