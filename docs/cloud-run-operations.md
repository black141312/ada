# ada-server on Cloud Run — operations runbook

How the **live** backend is run: the two regional instances, how to change them without letting them
drift, and where to watch them in the Google Cloud console.

For running the server locally or on another host, see [deploy.md](deploy.md). This file is only
about the deployed production service.

---

## The instances

There are **two**, and they are peers — same code, same database, same env (with two deliberate
exceptions below).

| Region | URL | Console |
|---|---|---|
| `asia-south1` (Mumbai) | `https://ada-server-1024230698481.asia-south1.run.app` | [metrics](https://console.cloud.google.com/run/detail/asia-south1/ada-server/metrics?project=ada-app-502717) · [logs](https://console.cloud.google.com/run/detail/asia-south1/ada-server/logs?project=ada-app-502717) · [revisions](https://console.cloud.google.com/run/detail/asia-south1/ada-server/revisions?project=ada-app-502717) |
| `us-west2` (Los Angeles) | `https://ada-server-1024230698481.us-west2.run.app` | [metrics](https://console.cloud.google.com/run/detail/us-west2/ada-server/metrics?project=ada-app-502717) · [logs](https://console.cloud.google.com/run/detail/us-west2/ada-server/logs?project=ada-app-502717) · [revisions](https://console.cloud.google.com/run/detail/us-west2/ada-server/revisions?project=ada-app-502717) |

Project `ada-app-502717` (number `1024230698481`), service `ada-server`, port 8787, max 20
instances, scale-to-zero. Both were added to the app in v0.1.44: the desktop app races `/health` on
startup and uses whichever answers first (`REGION_URLS` in `ada-app/src/app.js`).

**Two things differ per region, on purpose:**

- `BETTER_AUTH_URL` — each instance's own URL. Never copy one region's value to the other.
- The container image is built per-region (`<region>-docker.pkg.dev/...`), so the digests differ
  even when the source is identical. A digest mismatch is **not** evidence of drift; compare
  behaviour instead (see [Check the two match](#check-the-two-match)).

**Everything else must be identical.** The database (Supabase, Mumbai), the provider key, the auth
secret, and the admin list are all shared. GitHub sign-in only ever goes through the **asia** URL —
the OAuth app has exactly one registered callback.

---

## Golden rule: change both, then verify both

Every `gcloud run services update` targets **one** region. A change applied to one instance and not
the other is the single most likely way to break this setup, and it fails silently — half your users
get the old behaviour depending on which server their app picked that morning.

Do them back to back, then run the parity check.

---

## Add or remove an admin

Admin is decided by the `ADA_ALLOWED_USERS` env var (the code also accepts the newer name
`ADA_ADMIN_USERS`; only ever set **one** of them, or the newer silently wins). It is a
comma-separated list of **email addresses** — with GitHub sign-in the server identifies people by
the email on their account, via Better Auth. A GitHub *username* in this list matches nothing.

### What admin actually grants

Three things, all significant — this is not a read-only role:

- **God mode** — unmetered and never model-gated. No quota, no plan restrictions, every model, at
  your OpenRouter cost (`checkEntitlement` in [`src/server/plans.ts`](../src/server/plans.ts)).
- **Plan control** — `POST /v1/plans` sets any user's plan, bans accounts, overrides token caps.
- **Analytics** — `GET /v1/admin/analytics`: usage, funnel, revenue.

### The command

Pass the **whole list**, not just the new person — `--update-env-vars` replaces the variable.

```bash
gcloud run services update ada-server --project ada-app-502717 --region asia-south1 --quiet \
  --update-env-vars '^|^ADA_ALLOWED_USERS=first@example.com,second@example.com'
```

```bash
gcloud run services update ada-server --project ada-app-502717 --region us-west2 --quiet \
  --update-env-vars '^|^ADA_ALLOWED_USERS=first@example.com,second@example.com'
```

Then verify both:

```bash
for r in asia-south1 us-west2; do gcloud run services describe ada-server --project ada-app-502717 --region $r --format="value(spec.template.spec.containers[0].env.filter(\"name:ADA_ALLOWED_USERS\").extract(value))"; done
```

Removing an admin is the same command with that address dropped from the list. It takes effect on
the next request — no app release needed, though a signed-in session can keep working for up to
5 minutes (the identity cache TTL).

### The escaping gotcha — read this before setting any env var

`--update-env-vars` **splits on commas**, so a value containing a comma silently becomes two broken
variables. The `^|^` prefix at the start of the argument changes the delimiter to `|`, which is why
every command above starts with it. Use it for any value with a comma: the admin list, `PLAN_MAP`,
model lists.

Quotes are the other trap. **Run these from bash (Git Bash), not PowerShell.** PowerShell eats the
double quotes inside a JSON value — that is exactly how `KELVIQ_PLAN_MAP` ended up as
`{free-plan:free,pro-plan:pro}` on us-west2 (invalid JSON, silently ignored at startup, saved only
by the name-heuristic fallback in [`src/server/kelviq.ts`](../src/server/kelviq.ts)). In bash,
single-quote the whole argument and the JSON survives intact.

After setting anything JSON-shaped, read it back and confirm the quotes are still there.

---

## Deploy new server code

Only needed when `cos0/src/server/**` changes. Build each region from source, one after the other:

```bash
cd /c/Users/ADMIN/Desktop/ada/cos0
gcloud run deploy ada-server --source . --project ada-app-502717 --region asia-south1 --allow-unauthenticated
gcloud run deploy ada-server --source . --project ada-app-502717 --region us-west2 --allow-unauthenticated
```

Existing env vars and secrets survive a `--source` deploy — they live on the service, not the image.
Cloud Run health-checks each new revision and keeps traffic on the old one if it fails, so a bad
deploy degrades to "no change" rather than an outage. That safety is **per region**: if the second
deploy fails you are left running two different versions, which is why the parity check below
matters more than the deploy output.

### Check the two match

```bash
for h in https://ada-server-1024230698481.asia-south1.run.app https://ada-server-1024230698481.us-west2.run.app; do
  echo "$h  health=$(curl -s $h/health)  models=$(curl -s $h/v1/models | grep -o '"id"' | wc -l)  analytics=$(curl -s -o /dev/null -w '%{http_code}' $h/v1/admin/analytics)"
done
```

Both lines should read the same. `analytics=401` means the endpoint exists and wants auth — a `404`
on one side means that region is running older code.

### Roll back

Revisions are immutable and kept. In the console, open the region's **Revisions** tab, pick the last
good one, and use *Manage traffic* to send 100% to it. Or:

```bash
gcloud run services update-traffic ada-server --project ada-app-502717 --region <region> --to-revisions <revision>=100
```

---

## Monitoring in the Cloud console

### Start here

[**Cloud Run → services**](https://console.cloud.google.com/run?project=ada-app-502717) lists both
instances with their health at a glance. Click a service, and the tabs that matter are **Metrics**,
**Logs**, **Revisions**, and **Variables & Secrets**.

Remember to check **both regions** — the console shows one region at a time, and a quiet region
looks identical to a broken one until you read its logs.

### Metrics tab — what to actually look at

- **Request count** — your traffic. Near-zero on us-west2 is expected today; it exists for when US
  users show up.
- **Request latency (p95)** — the number the two-region setup exists to improve. Compare regions.
- **Container instance count** — should sit at 0 when idle. If it never returns to 0, something is
  holding connections open and you are paying for it.
- **Container startup latency** — cold starts. High values here are what users feel as a slow first
  message after an idle period.
- **Billable instance time** — the cost driver.

Set the time range to 7 days for a realistic picture; the default view is too short to show a trend.

### Logs

Per-service logs are on the **Logs** tab. For anything cross-cutting use the
[**Logs Explorer**](https://console.cloud.google.com/logs/query?project=ada-app-502717).

Errors only, both regions at once:

```
resource.type="cloud_run_revision"
resource.labels.service_name="ada-server"
severity>=ERROR
```

Where traffic is coming from (the caller IP is on every request log — geolocate the addresses to
learn which countries are hitting you):

```
resource.type="cloud_run_revision"
resource.labels.service_name="ada-server"
logName:"run.googleapis.com%2Frequests"
```

Same thing from the CLI:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="ada-server" AND logName:"run.googleapis.com%2Frequests"' --project ada-app-502717 --freshness=3d --limit=1000 --format="value(httpRequest.remoteIp,resource.labels.location,httpRequest.requestUrl,httpRequest.status)"
```

Logs are retained for **30 days** — this is always a recent window, never all-time history. Note
that requests from `Kelviq-Webhooks/1.0` on AWS addresses are the billing provider, not users.

### Alerts worth having

None are configured yet. The two that would earn their keep, both created under
[Monitoring → Alerting](https://console.cloud.google.com/monitoring/alerting?project=ada-app-502717):

- 5xx rate above a few percent over 5 minutes, per region.
- A [budget alert](https://console.cloud.google.com/billing/budgets) at ~$10/month. At current
  volume the service sits inside the free tier, so anything approaching real money means something
  changed.

### Cost

[Billing → Reports](https://console.cloud.google.com/billing), filtered to project
`ada-app-502717`. Both regions scale to zero, so an idle second region costs essentially nothing.

### Application-level monitoring

Cloud Run tells you about *requests*; `GET /v1/admin/analytics?days=30` tells you about *users* —
usage, funnel, and revenue, with computed improvement areas. It needs an admin token (see above) and
is served by both regions off the same database, so either URL returns the same answer.

---

## Secrets

`KELVIQ_API_KEY` and `KELVIQ_WEBHOOK_SECRET` come from
[Secret Manager](https://console.cloud.google.com/security/secret-manager?project=ada-app-502717)
and are mounted by reference, so rotating a secret there does not require touching the services.
The remaining sensitive values (`OPENROUTER_API_KEY`, `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`GITHUB_CLIENT_SECRET`) are plain env vars on the service — visible to anyone with console access,
and worth moving into Secret Manager when convenient. **Never paste their values into a doc, a
commit, or a chat.**

To see which variables are set without printing values, use the **Variables & Secrets** tab, or:

```bash
gcloud run services describe ada-server --project ada-app-502717 --region asia-south1 --format="value(spec.template.spec.containers[0].env[].name)"
```

---

## Known sharp edges

- **Sign-in is Mumbai-only.** One GitHub OAuth callback exists. A US user's chat is served from Los
  Angeles but their login round-trips to India. Fixing this properly means a load balancer and a
  custom domain (~$20/month), or a second OAuth app.
- **The database is in Mumbai.** The US region helps LLM streaming latency, not database work.
- **`ada-app/docs/RELEASING.md` used to describe a single region.** Backend deploys belong here now.
