---
name: angular-module
description: Scaffold an Angular feature module (or standalone feature) with lazy routing
category: frameworks
---

# Angular Module

Use to add a self-contained feature to an Angular app — a feature module (or standalone components) with its own components, routing, and services.

1. Generate the scaffold: `ng generate module features/<name> --routing` (or skip the module and use `--standalone` components on modern Angular).
2. Add components/services with `ng generate component features/<name>/<comp>` and `ng generate service features/<name>/<svc>`.
3. Define the feature's routes in its routing module/`routes` array, with a default child route and any guards/resolvers.
4. Wire lazy loading from the root router: `loadChildren: () => import('./features/<name>/<name>.module').then(m => m.<Name>Module)` (or `loadComponent` for standalone).
5. Provide feature-scoped services in the module `providers` (or `providedIn` a route) so they aren't global unless intended.
6. Run `ng serve`, navigate to the route, and confirm the chunk loads lazily and the feature renders.

## Rules
- Declare each component in exactly one NgModule; for standalone components, list deps in `imports` instead.
- Export only the components other modules actually use; keep internals private.
- Import `CommonModule` (not `BrowserModule`) in feature modules for `*ngIf`/`*ngFor`.
- Prefer lazy-loaded routes for features to keep the initial bundle small.
- Follow the generated file/selector naming and folder structure; don't hand-roll boilerplate the CLI produces.
