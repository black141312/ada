// The shared store (Postgres in prod, SQLite for dev), opened ON FIRST USE.
//
// This lived in auth.ts as a module-level `const`, which meant importing anything that touched the
// database — plans, usage, billing, allowlist, analytics — opened it, and on the SQLite branch that
// loads the native better-sqlite3 addon. The desktop bundle deliberately ships without that addon
// (ada-app extraResources: "!better-sqlite3/**"), so the packaged app's local gateway died at
// startup with:
//
//   Error: Cannot find module 'better-sqlite3'
//   requireStack: [ '…/resources/ada-cli/src/server/auth.ts' ]
//
// and the app fell back to the hosted backend — a signed-in Claude/ChatGPT plan stored, shown as
// connected, and never used. Six modules imported it; fixing one import path was not enough.
//
// Lazy fixes it at the root: a gateway that never touches accounts, plans or billing never opens a
// database, so it never needs the addon. Callers already read it through a thunk
// (`const pg = () => authDatabase()`), so nothing about their access pattern changes.

import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { sqliteOptions } from "./sqlite-binding.ts";

/** Postgres when DATABASE_URL is set — makes the backend stateless, so it runs on any container
 *  host without a persistent disk. Env-only, so reading it never opens anything. */
export const usingPostgres = !!process.env.DATABASE_URL;

let db: Pool | Database.Database | null = null;

/** The store, opened on first call and reused after. Throws only if something actually needs a
 *  database and none can be opened — which is the honest place for that failure, rather than at
 *  import time on behalf of code that may never run. */
export function authDatabase(): Pool | Database.Database {
  if (db) return db;
  db = usingPostgres
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : new (createRequire(import.meta.url)("better-sqlite3") as typeof Database)(
        process.env.ADA_AUTH_DB ?? "ada-auth.db",
        // The binary matching the runtime we're on: the app runs this under Electron's Node, whose
        // ABI differs from the system Node that npm installed for.
        sqliteOptions(),
      );
  return db;
}
