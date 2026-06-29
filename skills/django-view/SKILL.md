---
name: django-view
description: Add a Django view with its URL route and template
category: frameworks
---

# Django View

Use to add a new page or endpoint to a Django app — wiring a view, a URL pattern, and (for HTML) a template.

1. Write the view in the app's `views.py`: a function view taking `request` or a class-based view (e.g. `ListView`), returning `render(request, template, context)` or a `JsonResponse`.
2. Add a URL pattern in the app's `urls.py` with a `name=`, then `include()` that app's urls from the project `urls.py` if not already.
3. For HTML, create the template under `<app>/templates/<app>/<name>.html` and render context variables.
4. Query data via the ORM in the view; pass only what the template needs in `context`.
5. Reverse URLs with `{% url 'app:name' %}` / `reverse()` rather than hardcoding paths.
6. Run `python manage.py runserver`, hit the URL, and confirm the response and template render.

## Rules
- Namespace URLs with `app_name` in the app's `urls.py` and reference them as `'app:name'`.
- Keep business logic in models/services, not fat views; views orchestrate request → response.
- Protect mutating views with CSRF (forms) and the right method guards (`require_POST`, `LoginRequiredMixin`).
- Use `get_object_or_404` instead of bare `.get()` to avoid unhandled `DoesNotExist`.
- Don't put queries in templates; resolve them in the view and watch for N+1 (use `select_related`/`prefetch_related`).
