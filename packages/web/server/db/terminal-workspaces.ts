/**
 * Durable terminal workspaces, read and written by the web server.
 *
 * The web server's main control-plane handle is deliberately readonly
 * (SCO-031): the broker owns writes, through its journal. A terminal workspace
 * has no journal entry kind — it is a product object the operator authors in a
 * browser, and it is not part of the broker's agent/message model — so this
 * module keeps a second, narrow handle that touches ONE table.
 *
 * The constraints that make that safe, and which any change here must keep:
 *
 * - It never runs the control-plane migration pipeline. It creates its own
 *   table with the DDL the runtime owns, and that DDL is purely additive, so a
 *   build that predates it is unaffected. Crucially it does not stamp
 *   `user_version`: a stamp from here would make an older build sharing the
 *   same control home refuse to open the database.
 * - It only ever reads and writes `terminal_workspaces`.
 *
 * Follow-up: fold these writes into a broker journal entry kind
 * (`terminal.workspace.upsert` / `.delete`) once the broker grows one, and
 * delete the writable handle. That is the shape the rest of the control plane
 * uses and the shape this should end up in.
 */

import { Database } from "bun:sqlite";

import {
  normalizeTerminalWorkspaceColumns,
  parseTerminalWorkspaceLayoutJson,
  type TerminalWorkspaceCell,
  type TerminalWorkspaceRecord,
  type TerminalWorkspaceRecordInput,
} from "@openscout/protocol";
import { CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA } from "@openscout/runtime/schema";

import { db } from "./internal/db.ts";
import { resolveDbPath } from "./internal/db.ts";

type TerminalWorkspaceRow = {
  id: string;
  name: string;
  purpose: string;
  columns_count: number;
  layout_json: string | null;
  cells_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

let writeDb: Database | null = null;
let writeDbPath: string | null = null;

function writableDb(): Database {
  const path = resolveDbPath();
  // Reopen when the control home moves. It does not move in a running server,
  // but a cached handle pointing at a path the process no longer uses fails
  // with an opaque disk I/O error rather than anything diagnosable.
  if (writeDb && writeDbPath !== path) closeTerminalWorkspaceDb();
  if (!writeDb) {
    writeDb = new Database(path);
    writeDbPath = path;
    writeDb.exec("PRAGMA busy_timeout = 2000");
    writeDb.exec(CONTROL_PLANE_TERMINAL_WORKSPACE_SQLITE_SCHEMA);
    applyTerminalWorkspaceShapeRepairs(writeDb);
  }
  return writeDb;
}

/**
 * Bring an existing table up to the current shape.
 *
 * The DDL above is `CREATE TABLE IF NOT EXISTS`, which is a no-op on a
 * database that already has the table — so a column added to it later never
 * reaches a machine that ran an earlier build, and the field it backs silently
 * fails to persist there. That is exactly what happened to `layout_json`. This
 * handle deliberately does not run the control-plane migration pipeline
 * (see the module header), so it repairs the one table it owns itself, with
 * the same guarded ALTER the runtime migration uses.
 */
function applyTerminalWorkspaceShapeRepairs(database: Database): void {
  const columns = database.query("SELECT name FROM pragma_table_info('terminal_workspaces')")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "layout_json")) {
    database.exec("ALTER TABLE terminal_workspaces ADD COLUMN layout_json TEXT");
  }
}

/** Call on server shutdown. */
export function closeTerminalWorkspaceDb(): void {
  writeDb?.close();
  writeDb = null;
  writeDbPath = null;
}

export function queryTerminalWorkspaces(options: { limit?: number } = {}): TerminalWorkspaceRecord[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
  try {
    return (db().query(
      `SELECT *
       FROM terminal_workspaces
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
    ).all(limit) as TerminalWorkspaceRow[]).map(terminalWorkspaceFromRow);
  } catch (error) {
    // Nobody has authored a workspace on this install yet.
    if (isMissingTerminalWorkspaceTable(error)) return [];
    throw error;
  }
}

export function queryTerminalWorkspace(id: string): TerminalWorkspaceRecord | null {
  try {
    const row = db().query("SELECT * FROM terminal_workspaces WHERE id = ?").get(id) as
      | TerminalWorkspaceRow
      | null;
    return row ? terminalWorkspaceFromRow(row) : null;
  } catch (error) {
    if (isMissingTerminalWorkspaceTable(error)) return null;
    throw error;
  }
}

export function upsertTerminalWorkspace(input: TerminalWorkspaceRecordInput): TerminalWorkspaceRecord {
  const id = input.id?.trim() || `tw.${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = Date.now();
  writableDb().query(
    `INSERT INTO terminal_workspaces (
       id, name, purpose, columns_count, layout_json, cells_json, metadata_json, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       purpose = excluded.purpose,
       columns_count = excluded.columns_count,
       layout_json = excluded.layout_json,
       cells_json = excluded.cells_json,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.name,
    input.purpose ?? "",
    normalizeTerminalWorkspaceColumns(input.columns),
    input.layout === undefined ? null : JSON.stringify(input.layout),
    JSON.stringify(input.cells ?? []),
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    now,
    now,
  );
  // Read back through the writable handle: the readonly connection may not see
  // the WAL frame this write just produced.
  const row = writableDb().query("SELECT * FROM terminal_workspaces WHERE id = ?").get(id) as
    | TerminalWorkspaceRow
    | null;
  if (!row) throw new Error(`failed to persist terminal workspace ${id}`);
  return terminalWorkspaceFromRow(row);
}

export function deleteTerminalWorkspace(id: string): boolean {
  const result = writableDb().query("DELETE FROM terminal_workspaces WHERE id = ?").run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

function terminalWorkspaceFromRow(row: TerminalWorkspaceRow): TerminalWorkspaceRecord {
  const layout = parseTerminalWorkspaceLayoutJson(row.layout_json);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    columns: normalizeTerminalWorkspaceColumns(row.columns_count),
    // Absent for rows written before layouts were stored. The record then
    // carries only the resolved column count, and `terminalWorkspaceLayoutOf`
    // infers a shape from it — a fold-forward, not a substitute for the real
    // thing, which is why the column exists.
    ...(layout ? { layout } : {}),
    cells: parseJson<TerminalWorkspaceCell[]>(row.cells_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * True when the absence is structural rather than a fault: no workspace has
 * ever been authored here, so the table (or the whole control-plane database)
 * does not exist yet. An empty library is the right answer; a 500 is not.
 */
function isMissingTerminalWorkspaceTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table: terminal_workspaces/i.test(message)
    || /unable to open database/i.test(message);
}
