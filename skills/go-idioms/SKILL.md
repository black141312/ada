---
name: go-idioms
description: Apply idiomatic Go for error handling, context propagation, and interface design
category: languages
---

# Go Idioms

Use this when reviewing or refactoring Go that fights the language — swallowed errors, missing context, or fat interfaces.

1. Handle every error explicitly at the call site: return it wrapped with `fmt.Errorf("doing X: %w", err)` so callers can `errors.Is`/`errors.As` it; never discard with `_` unless intentional and commented.
2. Thread `context.Context` as the first parameter through any call that does I/O or can block, and honor cancellation (`ctx.Err()`, `<-ctx.Done()`).
3. Define interfaces where they're consumed, keep them small (one or two methods), and accept interfaces but return concrete types.
4. Use `defer` for cleanup (close, unlock) right after acquiring the resource; prefer `sync.Mutex` zero-value over pointers and don't copy locks.
5. Replace sentinel-error string matching with typed errors or `errors.Is`, and use `errors.Join` to aggregate when needed.
6. Run `go vet`, `gofmt`/`goimports`, and `staticcheck`; fix shadowed `err`, unchecked returns, and ineffective assignments.

## Rules
- Wrap errors with `%w` (not `%v`) when callers may need to inspect the cause; add context, don't just rethrow.
- Don't start goroutines you can't stop — every goroutine needs a clear exit path tied to a context or channel close.
- Avoid `interface{}`/`any` in APIs; use concrete types or generics. Empty interfaces push type errors to runtime.
- Name things tersely and idiomatically (`r io.Reader`, not `reader`), and return early instead of nesting `if/else`.
- Don't panic across package boundaries — return errors; reserve `panic` for truly unrecoverable programmer bugs.
