---
name: fastapi-endpoint
description: Add a FastAPI endpoint with Pydantic request/response models and DI
category: frameworks
---

# FastAPI Endpoint

Use to add a typed FastAPI route with Pydantic schemas for validation and serialization, plus dependency injection where needed.

1. Define Pydantic models for the request body and response (`response_model=`); use separate input/output schemas to avoid leaking fields.
2. Add the path operation on a `router`/`app` with the right verb decorator (`@router.post("/items")`) and type-annotated params.
3. Declare params by source: path (`item_id: int`), query (defaults), body (Pydantic model) — FastAPI infers from the annotation.
4. Inject shared resources (DB session, current user) via `Depends(...)`; raise `HTTPException` for error cases.
5. Set `status_code=` and `response_model=` explicitly; keep the handler thin and delegate logic to functions/services.
6. Run `uvicorn app:app --reload`, check `/docs`, and exercise the endpoint to confirm validation and shape.

## Rules
- Use distinct input vs output Pydantic models; never return ORM objects without a `response_model` to filter fields.
- Type every parameter — FastAPI's validation and docs derive entirely from annotations.
- Use `Depends` for DB sessions/auth instead of globals; it makes endpoints testable.
- Raise `HTTPException(status_code, detail)` for expected errors; don't return ad-hoc error dicts.
- For DB or external I/O, prefer `async def` with async clients, or keep blocking calls in `def` handlers (FastAPI offloads them).
