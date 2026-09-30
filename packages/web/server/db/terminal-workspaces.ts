/**
 * Durable terminal workspaces: named arrangements of agent-CLI tiles that the
 * operator authors in a browser. They are a web product object, not part of
 * the broker's agent/message model, so they live in the web server's own
 * database (`internal/web-db.ts`) rather than the broker's control plane.
 */

import {
  normalizeTerminalWorkspaceColumns,
  parseTerminalWorkspaceLayoutJson,
  type TerminalWorkspaceCell,
  type TerminalWorkspaceRecord,
  type TerminalWorkspaceRecordInput,
} from "@openscout/protocol";
import { closeWebDb, webDb } from "./internal/web-db.ts";

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

/** Call on server shutdown. */
export function closeTerminalWorkspaceDb(): void {
  closeWebDb();
}

export function queryTerminalWorkspaces(options: { limit?: number } = {}): TerminalWorkspaceRecord[] {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
  return (webDb().query(
    `SELECT *
     FROM terminal_workspaces
     ORDER BY updated_at DESC, id ASC
     LIMIT ?`,
  ).all(limit) as TerminalWorkspaceRow[]).map(terminalWorkspaceFromRow);
}

export function queryTerminalWorkspace(id: string): TerminalWorkspaceRecord | null {
  const row = webDb().query("SELECT * FROM terminal_workspaces WHERE id = ?").get(id) as
    | TerminalWorkspaceRow
    | null;
  return row ? terminalWorkspaceFromRow(row) : null;
}

export function upsertTerminalWorkspace(input: TerminalWorkspaceRecordInput): TerminalWorkspaceRecord {
  const id = input.id?.trim() || `tw.${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const now = Date.now();
  webDb().query(
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
  const row = webDb().query("SELECT * FROM terminal_workspaces WHERE id = ?").get(id) as
    | TerminalWorkspaceRow
    | null;
  if (!row) throw new Error(`failed to persist terminal workspace ${id}`);
  return terminalWorkspaceFromRow(row);
}

export function deleteTerminalWorkspace(id: string): boolean {
  const result = webDb().query("DELETE FROM terminal_workspaces WHERE id = ?").run(id) as {
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
