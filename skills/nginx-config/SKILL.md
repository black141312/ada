---
name: nginx-config
description: Write or optimize an nginx config for a reverse proxy or static site
category: cloud
---

# Nginx Config

Reach for this when configuring nginx as a reverse proxy, static file server, or TLS terminator — and when tightening an existing config for performance or security.

1. Define one `server` block per virtual host with `server_name` and the correct `listen` (80 and 443).
2. For proxying, set `proxy_pass` plus the standard forwarded headers (`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`).
3. For TLS, point `ssl_certificate`/`ssl_certificate_key` at the certs and redirect `:80` to `:443`.
4. Enable `gzip` (or brotli) and set cache headers / `expires` for static assets.
5. Add security headers (`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`) and hide `server_tokens off`.
6. Test with `nginx -t`, then reload with `nginx -s reload` — never a hard restart for a config change.

## Rules
- Always `nginx -t` before reloading; a syntax error on restart takes the site down.
- Set `client_max_body_size` to match real upload needs — the 1MB default silently rejects larger requests.
- Tune `proxy_read_timeout`/`proxy_connect_timeout` for slow upstreams instead of leaving defaults.
- Don't terminate TLS with weak protocols; set `ssl_protocols TLSv1.2 TLSv1.3` and a modern cipher list.
- Use `upstream` blocks with health-aware load balancing rather than hardcoding a single backend when you have several.
