---
name: ssl-setup
description: Set up TLS certificates with Let's Encrypt and automate renewal
category: cloud
---

# SSL Setup

Use this to get a domain onto HTTPS with a free, auto-renewing Let's Encrypt certificate — and to make sure renewal won't silently lapse.

1. Confirm the domain's DNS A/AAAA record points at the server and ports 80/443 are reachable.
2. Pick a challenge: HTTP-01 (certbot --webroot/--nginx) for a public server, or DNS-01 for wildcards and private hosts.
3. Issue the cert with certbot (e.g. `certbot --nginx -d example.com -d www.example.com`), supplying a contact email.
4. Wire the cert into the server (nginx/apache) and force HTTP→HTTPS redirects.
5. Verify the chain and expiry with `openssl s_client -connect host:443` or an SSL Labs scan.
6. Confirm auto-renewal: `certbot renew --dry-run` and ensure the systemd timer / cron job is active.

## Rules
- Let's Encrypt certs last 90 days — renewal MUST be automated; a manual process will eventually expire.
- Test against the staging ACME endpoint first to avoid hitting rate limits on bad attempts.
- Use DNS-01 for wildcard (`*.example.com`) certs; HTTP-01 can't issue wildcards.
- Keep private keys `600` and owned by the service user; never commit them to git.
- After renewal, reload (not restart) the web server so it picks up the new cert with zero downtime.
