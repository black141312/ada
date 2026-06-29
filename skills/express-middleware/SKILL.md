---
name: express-middleware
description: Add Express middleware for auth, logging, or error handling in the right order
category: frameworks
---

# Express Middleware

Use to add cross-cutting behavior (authentication, request logging, error handling) to an Express app via middleware, registered in the correct order.

1. Decide the type: request middleware `(req, res, next)` for logging/auth, or error middleware `(err, req, res, next)` (four args) for errors.
2. Write it in its own module; do work, attach to `req` (e.g. `req.user`), then call `next()` — or `next(err)` to fail.
3. Register globally with `app.use(fn)` or per-route with `router.get(path, mw, handler)`; order matters — earlier `use` runs first.
4. For auth, validate the token/session, reject with `401`/`403` (don't call `next()`), or set `req.user` and continue.
5. Mount error-handling middleware last, after all routes, so thrown/`next(err)` errors funnel into one place.
6. Run the server and verify: logs appear, protected routes reject without creds, and errors return clean JSON not stack traces.

## Rules
- Always call `next()` (or send a response) — forgetting it hangs the request.
- Error middleware MUST have four parameters or Express treats it as normal middleware.
- Register body parsers and loggers before routes; register the error handler after them.
- In async middleware, wrap or `try/catch` and pass errors to `next(err)` — thrown async errors aren't auto-caught (pre-Express 5).
- Don't leak internals: log the full error server-side, return a sanitized message/status to the client.
