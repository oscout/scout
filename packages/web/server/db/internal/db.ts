/**
 * Readonly SQLite handle for the web server's direct reads of the control-plane
 * database. Lifted from db-queries.ts as part of SCO-031 Phase A.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/* ── DB path ── */

export function resolveDbPath(): string {
  const controlHome =
    process.env.OPENSCOUT_CONTROL_HOME ??
    join(homedir(), ".openscout", "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

/* ── Readonly connection (WAL-visible without periodic reopen) ── */

let _db: Database | null = null;
const DB_BUSY_TIMEOUT_MS = 250; // keep UI reads short under broker write contention

export function configureReadonlyDb(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA query_only = ON");
}

export function db(): Database {
  if (!_db) {
    _db = new Database(resolveDbPath(), { readonly: true });
    configureReadonlyDb(_db);
  }
  return _db;
}

/** Call on server shutdown. */
export function closeDb(): void {
  _db?.close();
  _db = null;
}
