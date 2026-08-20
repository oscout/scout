import type { TerminalSessionRecord, TerminalSurface } from "@openscout/protocol";

import { db } from "./internal/db.ts";

type TerminalSessionRow = {
  id: string;
  harness: string;
  source_session_id: string;
  cwd: string;
  resume_command: string;
  surfaces_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

export type TerminalSessionListOptions = {
  harness?: string;
  sourceSessionId?: string;
  backend?: TerminalSurface["backend"];
  limit?: number;
};

export function queryTerminalSessions(options: TerminalSessionListOptions = {}): TerminalSessionRecord[] {
  const predicates: string[] = [];
  const params: Array<string | number> = [];

  if (options.harness) {
    predicates.push("harness = ?");
    params.push(options.harness);
  }
  if (options.sourceSessionId) {
    predicates.push("source_session_id = ?");
    params.push(options.sourceSessionId);
  }

  const limit = normalizedListLimit(options.limit);
  params.push(limit);
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  let rows: TerminalSessionRow[];
  try {
    rows = db().query(
      `SELECT *
       FROM terminal_session_registry
       ${where}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
    ).all(...params) as TerminalSessionRow[];
  } catch (error) {
    if (isMissingTerminalSessionRegistryError(error)) {
      return [];
    }
    throw error;
  }
  const records = rows.map(terminalSessionFromRow);

  if (!options.backend) {
    return records;
  }
  return records.filter((record) =>
    record.surfaces.some((surface) => surface.backend === options.backend),
  );
}

function terminalSessionFromRow(row: TerminalSessionRow): TerminalSessionRecord {
  return {
    id: row.id,
    harness: row.harness,
    sourceSessionId: row.source_session_id,
    cwd: row.cwd,
    resumeCommand: row.resume_command,
    surfaces: parseJson<TerminalSurface[]>(row.surfaces_json, []),
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

function normalizedListLimit(value: number | undefined, fallback = 100, max = 1000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function isMissingTerminalSessionRegistryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table: terminal_session_registry/i.test(message);
}
