---
name: cpp-raii
description: Apply RAII and smart pointers to replace manual resource management in C++
category: languages
---

# Cpp Raii

Use this when modernizing C++ that leaks, double-frees, or manually pairs new/delete and open/close, by tying resource lifetimes to scope.

1. Find raw owning resources: `new`/`delete`, `malloc`/`free`, `fopen`, locks, sockets, handles — each is a candidate for an RAII wrapper.
2. Replace owning raw pointers with `std::unique_ptr` (sole ownership) or `std::shared_ptr` (shared); use `std::make_unique`/`std::make_shared` instead of bare `new`.
3. Wrap non-memory resources (files, mutexes, handles) in a class whose destructor releases them, or use existing guards like `std::lock_guard`/`std::scoped_lock`.
4. Apply the Rule of Zero: prefer types that need no custom destructor/copy/move because members manage themselves; if you write one special member, consider all five.
5. Pass non-owning references as raw pointers or references (or `std::span`/`std::string_view`); reserve smart pointers for transferring or sharing ownership.
6. Build with sanitizers (`-fsanitize=address,leak,undefined`) and run the suite to confirm leaks and use-after-free are gone.

## Rules
- Never `delete` a pointer owned by a smart pointer, and never store the same raw pointer in two owning smart pointers — that's a double free.
- Default to `unique_ptr`; reach for `shared_ptr` only when ownership is genuinely shared, and break reference cycles with `weak_ptr`.
- Don't pass `shared_ptr` by value through call chains that don't take ownership — it churns the atomic refcount; pass `const&` or the raw pointer.
- Acquire resources in the constructor and release in the destructor; never leave a half-constructed object owning a resource (throw before acquiring, not after).
- Prefer `make_unique`/`make_shared` over `new` to stay exception-safe and avoid leaks from evaluation-order pitfalls.
