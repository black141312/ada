-- D1 schema for the ada Worker backend (seats / policy / usage / audit).
--   npx wrangler d1 execute ada --file src/worker/schema.sql --remote
-- Prototype-safe auth by construction: seat lookup is a parameterized `WHERE key = ?` bind.

CREATE TABLE IF NOT EXISTS seats (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'dev',
  disabled    INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,               -- OIDC iss#sub (reserved for the SSO follow-up)
  iss         TEXT,
  created     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy (
  id   INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  ts               INTEGER NOT NULL,
  user             TEXT NOT NULL,
  model            TEXT NOT NULL,
  provider         TEXT NOT NULL,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts);

CREATE TABLE IF NOT EXISTS audit (
  ts     INTEGER NOT NULL,
  user   TEXT NOT NULL,
  event  TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
