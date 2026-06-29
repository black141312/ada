---
name: laravel-controller
description: Scaffold a Laravel controller with routes, form request, and Eloquent model
category: frameworks
---

# Laravel Controller

Use to add a resource to a Laravel app — controller, routes, validation, and Eloquent model — following Laravel conventions.

1. Generate the pieces: `php artisan make:model <Name> -mcr` (model + migration + resource controller) and a `make:request` for validation.
2. Edit the migration columns, then `php artisan migrate`; set `$fillable`/`$casts` and relationships on the model.
3. Register routes with `Route::resource('<plural>', <Name>Controller::class)` in `routes/web.php` or `routes/api.php`.
4. Type-hint the Form Request in controller actions so validation runs automatically; use `$request->validated()`.
5. Implement the resource actions, leaning on route-model binding (`<Name> $model`) and returning views or JSON/API resources.
6. Run `php artisan serve`, confirm routes with `php artisan route:list`, and exercise CRUD.

## Rules
- Validate with Form Request classes, not inline `$request->validate` scattered everywhere; use `validated()` for mass assignment.
- Set `$fillable` (or `$guarded`) on models to prevent mass-assignment vulnerabilities.
- Use route-model binding instead of manual `find` + 404 checks.
- Return API Resources (`->toResource()` / `JsonResource`) for API responses rather than raw models.
- Keep controllers thin; push reusable logic into services or model methods, and use `php artisan` generators over hand-rolling files.
