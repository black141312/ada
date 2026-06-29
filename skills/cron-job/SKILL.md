---
name: cron-job
description: Set up a reliable scheduled job via cron or a systemd timer, with logging and failure visibility
category: shell
---

# Cron Job

Use this when scheduling recurring work — backups, syncs, cleanups, health checks — via cron or systemd timers.

1. Choose the mechanism: classic `cron`/`crontab -e` for simple periodic jobs, or a systemd `.timer` + `.service` pair when you need dependencies, resource limits, or `journalctl` logging.
2. Have cron call a single self-contained script (with `set -euo pipefail`), not a long inline command — cron's minimal env and lack of quoting bites inline one-liners.
3. Use absolute paths for the binary, inputs, and outputs; cron runs with a bare `PATH` and no shell profile, so never assume `~`, aliases, or sourced env are present.
4. Redirect output to a log (`>> /var/log/job.log 2>&1`) or rely on the journal for timers; a silent cron job that fails is invisible.
5. Pick the schedule explicitly (`m h dom mon dow` for cron, `OnCalendar=` for timers) and add jitter/`RandomizedDelaySec` if many hosts fire at once.
6. Test by running the script manually first, then trigger the unit (`systemctl start job.service`) or wait one cycle and check the log before walking away.

## Rules
- Guard against overlapping runs with `flock -n /tmp/job.lock` (cron) or systemd's default single-instance behavior.
- Make the job idempotent so a missed or doubled run doesn't corrupt state.
- Set `MAILTO=` or pipe failures to an alert; never let errors vanish into `/dev/null`.
- Enable the timer to survive reboots: `systemctl enable --now job.timer`, and use `Persistent=true` to catch missed runs while powered off.
- Pin the timezone you expect (`CRON_TZ=` / `OnCalendar` with explicit TZ) — DST shifts silently break wall-clock schedules.
