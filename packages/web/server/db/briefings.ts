/**
 * Briefing Room — persistent three-layer archive of Scoutbot-generated briefs.
 *
 * Briefs are authored by the web server, so they live in its own database
 * (`internal/web-db.ts`), not the broker's control plane.
 *
 * Rolling 100-cap is enforced at insert time: after each insert, prune to keep
 * only the most recent `MAX_BRIEFINGS` rows.
 */

import type { Database } from "bun:sqlite";

import { epochMs } from "@openscout/protocol";
import {
  briefingsTable,
  desc,
  eq,
  openControlPlaneDrizzle,
  sql,
} from "@openscout/runtime/drizzle";

import { closeWebDb, webDb } from "./internal/web-db.ts";

const MAX_BRIEFINGS = 100;

let _drizzle: ReturnType<typeof openControlPlaneDrizzle> | null = null;
let _drizzleDb: Database | null = null;

function getDb() {
  const database = webDb();
  if (!_drizzle || _drizzleDb !== database) {
    _drizzle = openControlPlaneDrizzle(database);
    _drizzleDb = database;
  }
  return _drizzle;
}

export type BriefingKind = "fleet-home" | "tour";

export type SaveBriefingInput = {
  id: string;
  kind: BriefingKind;
  title: string;
  summary: string;
  recommendation?: string | null;
  preparedAt: number;
  ttlMs: number;
  brief: unknown;
  observations: unknown;
  snapshot: unknown;
  call: unknown;
  /** SCO-037: canonical markdown body. Optional for rows persisted before the markdown pipeline landed. */
  markdown?: string | null;
};

export type SavedBriefingRow = {
  id: string;
  kind: BriefingKind;
  title: string;
  summary: string;
  recommendation: string | null;
  preparedAt: number;
  ttlMs: number;
  brief: unknown;
  observations: unknown;
  snapshot: unknown;
  call: unknown;
  markdown: string | null;
  createdAt: number;
};

export type BriefingSummary = {
  id: string;
  kind: BriefingKind;
  title: string;
  summary: string;
  recommendation: string | null;
  preparedAt: number;
  ttlMs: number;
  observationCount: number;
  hasMarkdown: boolean;
  createdAt: number;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTimestampMs(value: number): number {
  return epochMs(value) ?? value;
}

function rowToRecord(row: typeof briefingsTable.$inferSelect): SavedBriefingRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    preparedAt: row.preparedAt,
    ttlMs: row.ttlMs,
    brief: parseJson(row.briefJson, null),
    observations: parseJson(row.observationsJson, []),
    snapshot: parseJson(row.snapshotJson, {}),
    call: parseJson(row.callJson, {}),
    markdown: row.markdown ?? null,
    createdAt: normalizeTimestampMs(row.createdAt),
  };
}

function rowToSummary(row: typeof briefingsTable.$inferSelect): BriefingSummary {
  const observations = parseJson<unknown[]>(row.observationsJson, []);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    preparedAt: row.preparedAt,
    ttlMs: row.ttlMs,
    observationCount: Array.isArray(observations) ? observations.length : 0,
    hasMarkdown: typeof row.markdown === "string" && row.markdown.length > 0,
    createdAt: normalizeTimestampMs(row.createdAt),
  };
}

export function saveBriefing(input: SaveBriefingInput): SavedBriefingRow {
  const db = getDb();
  const createdAt = Date.now();
  const markdown = typeof input.markdown === "string" && input.markdown.length > 0
    ? input.markdown
    : null;
  const row = {
    id: input.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    recommendation: input.recommendation ?? null,
    preparedAt: input.preparedAt,
    ttlMs: input.ttlMs,
    briefJson: JSON.stringify(input.brief),
    observationsJson: JSON.stringify(input.observations),
    snapshotJson: JSON.stringify(input.snapshot),
    callJson: JSON.stringify(input.call),
    markdown,
    createdAt,
  };
  db.insert(briefingsTable)
    .values(row)
    .onConflictDoUpdate({
      target: briefingsTable.id,
      set: {
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        recommendation: row.recommendation,
        preparedAt: row.preparedAt,
        ttlMs: row.ttlMs,
        briefJson: row.briefJson,
        observationsJson: row.observationsJson,
        snapshotJson: row.snapshotJson,
        callJson: row.callJson,
        markdown: row.markdown,
      },
    })
    .run();
  pruneBriefings(MAX_BRIEFINGS);
  return rowToRecord(row);
}

export function listBriefings(opts: { limit?: number } = {}): BriefingSummary[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_BRIEFINGS);
  const rows = db
    .select()
    .from(briefingsTable)
    .orderBy(desc(briefingsTable.createdAt))
    .limit(limit)
    .all();
  return rows.map(rowToSummary);
}

export function getBriefing(id: string): SavedBriefingRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(briefingsTable)
    .where(eq(briefingsTable.id, id))
    .get();
  return row ? rowToRecord(row) : null;
}

type SqliteRunResult = { changes: number; lastInsertRowid: number | bigint };

export function deleteBriefing(id: string): boolean {
  const db = getDb();
  const result = db
    .delete(briefingsTable)
    .where(eq(briefingsTable.id, id))
    .run() as unknown as SqliteRunResult;
  return result.changes > 0;
}

/**
 * Keep only the most recent `maxRows` rows by `createdAt`.
 * Returns the number of rows deleted.
 */
export function pruneBriefings(maxRows: number): number {
  const db = getDb();
  const result = db
    .delete(briefingsTable)
    .where(
      sql`id NOT IN (
        SELECT id FROM briefings ORDER BY created_at DESC LIMIT ${maxRows}
      )`,
    )
    .run() as unknown as SqliteRunResult;
  return result.changes;
}

export function closeBriefingsDb(): void {
  closeWebDb();
  _drizzle = null;
  _drizzleDb = null;
}
