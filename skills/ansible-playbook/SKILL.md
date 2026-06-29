---
name: ansible-playbook
description: Write an idempotent Ansible playbook with roles, variables, and handlers
category: cloud
---

# Ansible Playbook

Use this to automate configuration of one or more hosts — installing packages, templating configs, managing services — in a repeatable, idempotent way.

1. Define the inventory (hosts/groups) and confirm connectivity with `ansible all -m ping`.
2. Structure logic into roles (`roles/<name>/{tasks,handlers,templates,defaults}`) rather than one monolithic play.
3. Write tasks using purpose-built modules (`apt`, `copy`, `template`, `service`) — not `command`/`shell` unless unavoidable.
4. Put tunables in `defaults/main.tf` (lowest precedence) and environment specifics in group/host vars; reference with `{{ }}`.
5. Use `notify` + `handlers` to restart services only when a config actually changes.
6. Dry-run with `ansible-playbook --check --diff`, then apply for real.
7. Lint with `ansible-lint` and keep tasks `--check`-clean so re-runs report no changes.

## Rules
- Every task must be idempotent — re-running the playbook should report `changed=0` once converged.
- Encrypt secrets with `ansible-vault`; never commit plaintext credentials to vars files.
- Prefer modules over `shell`; when you must use `shell`, add `creates`/`removes` or a `when`/`changed_when` guard.
- Name every task descriptively so output and failures are readable.
- Use `become` only on tasks that need privilege escalation, not blanket at play level when avoidable.
