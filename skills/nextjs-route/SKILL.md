---
name: nextjs-route
description: Add a Next.js App Router page or route handler with the right runtime
category: frameworks
---

# Next.js Route

Use to add a new page or API endpoint under the Next.js App Router (`app/`), choosing server vs client and the correct file convention.

1. Pick the segment path under `app/` (e.g. `app/dashboard/`); use `[param]` for dynamic and `(group)` for layout grouping without a URL segment.
2. For UI, add `page.tsx` (a Server Component by default); add `loading.tsx`, `error.tsx`, or `layout.tsx` siblings as needed.
3. For an API endpoint, add `route.ts` and export async functions named after HTTP verbs (`GET`, `POST`, …) taking `(req: Request, { params })`.
4. Fetch data directly in async Server Components or in the handler; return `Response`/`NextResponse.json()` from route handlers.
5. Add `'use client'` at the top only for components needing state, effects, or browser APIs; keep data-fetching on the server.
6. Run `next dev`, hit the route, and confirm the rendered/JSON output and status codes.

## Rules
- A folder can't have both `page.tsx` and `route.ts` at the same segment — pick one.
- Server Components can't use hooks, event handlers, or `window`; push those into a `'use client'` child.
- Set `export const dynamic`/`revalidate` deliberately when you need caching or always-fresh data.
- Read dynamic params from the function args, not from `useParams`, inside Server Components and handlers.
- Don't leak secrets to the client — env vars without `NEXT_PUBLIC_` stay server-only; keep them out of client components.
