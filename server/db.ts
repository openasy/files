import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. The files themselves are in
// OpenCloud; this file holds sign-in (from @openasy/auth), which OpenCloud space each space of the file is, the people
// and groups Identity named at sign-in, what the last sync found about links, link openings from OpenCloud's audit log,
// handovers when someone leaves, and the history of syncs.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- Each time OpenCloud was brought in step with the file, and what changed. The last 100 are kept.
   CREATE TABLE sync_runs (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     created INTEGER NOT NULL,
     updated INTEGER NOT NULL,
     disabled INTEGER NOT NULL,
     links INTEGER NOT NULL,
     purged INTEGER NOT NULL,
     error TEXT
   );
   -- The OpenCloud space (drive) each space of the file was made as. Matched by id, so a rename stays the same space.
   CREATE TABLE spaces (name TEXT PRIMARY KEY COLLATE NOCASE, drive_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
   -- People who signed in to Files, with the Identity groups their last sign-in carried.
   CREATE TABLE people (email TEXT PRIMARY KEY, name TEXT NOT NULL, groups TEXT NOT NULL, seen_at TEXT NOT NULL);
   -- Links to people outside, as the last sync found them in OpenCloud, with what the policy made of them.
   CREATE TABLE links (
     id TEXT PRIMARY KEY,
     drive_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     item_name TEXT NOT NULL,
     folder INTEGER NOT NULL,
     by_email TEXT NOT NULL,
     display_name TEXT,
     type TEXT NOT NULL,
     has_password INTEGER NOT NULL,
     created_at TEXT,
     expires_at TEXT,
     web_url TEXT NOT NULL,
     token TEXT NOT NULL,
     problem TEXT,
     seen_at TEXT NOT NULL
   );
   CREATE INDEX links_token ON links (token);
   -- Link openings from OpenCloud's audit log (public_link_accessed). Kept 400 days.
   CREATE TABLE link_opens (id INTEGER PRIMARY KEY, token TEXT NOT NULL, item_id TEXT, at TEXT NOT NULL, success INTEGER NOT NULL);
   CREATE INDEX link_opens_token ON link_opens (token, at);
   -- Someone leaving: on the day, their personal files go to a space of their manager's.
   CREATE TABLE handovers (
     id TEXT PRIMARY KEY,
     person TEXT NOT NULL,
     manager TEXT NOT NULL,
     on_date TEXT NOT NULL,
     status TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     done_at TEXT,
     drive_id TEXT,
     bytes INTEGER,
     error TEXT
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
