---
name: rails-resource
description: Scaffold a Rails resource with model, migration, controller, and routes
category: frameworks
---

# Rails Resource

Use to add a new resource to a Rails app — model + migration, RESTful controller, and routes — following convention over configuration.

1. Generate it: `rails generate scaffold <Name> field:type ...` (or `model` + `controller` separately for finer control).
2. Review the migration, adjust columns/indexes/null constraints, then run `rails db:migrate`.
3. Add `resources :<plural>` to `config/routes.rb` (only needed if you didn't use full scaffold), scoping or nesting as appropriate.
4. Lock down `params` with a strong-parameters `permit` list in the controller; add validations to the model.
5. Adjust controller actions and views to match real requirements; remove unused scaffold actions.
6. Run `rails server` and the generated tests; verify CRUD via the routes (`rails routes` to confirm paths).

## Rules
- Always use strong parameters (`params.require(:x).permit(...)`); never pass raw `params` to `create`/`update`.
- Put validations and business rules on the model, not the controller.
- Keep controller actions thin and RESTful; reach for service objects before bloating actions.
- Add DB-level constraints/indexes in the migration, not just model validations.
- Run `rails db:migrate` (and commit `schema.rb`) before relying on the new table; never edit `schema.rb` by hand.
