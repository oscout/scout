/**
 * Briefing Room — persistent three-layer archive of Scoutbot-generated briefs.
 *
 * Opens its own writeable SQLite handle (separate from the readonly handle in
 * `internal/db.ts`) so the web server can save briefs after generation.
 * Multi-process safe via WAL — the control plane store (in
 * `packages/runtime/src/sqlite-store.ts`) and this module both open the same
 * file with `busy_timeout` and journal_mode=WAL.
 *
 * Rolling 100-cap is enforced at insert time: after each insert, prune to keep
 * only the most recent `MAX_BRIEFINGS` rows.
 *
 * Schema is created by the runtime store on startup (the
 * `CONTROL_PLANE_SQLITE_SCHEMA` constant in `packages/runtime/src/schema.ts`
 * has the `briefings` CREATE TABLE IF NOT EXISTS).
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { epochMs } from "@openscout/protocol";
import {
  briefingsTable,
  desc,
  eq,
  openControlPlaneDrizzle,
  sql,
} from "@openscout/runtime/drizzle";

const MAX_BRIEFINGS = 100;
const DB_BUSY_TIMEOUT_MS = 2_500;

let _db: Database | null = null;
let _drizzle: ReturnType<typeof openControlPlaneDrizzle> | null = null;

function resolveDbPath(): string {
  const explicit = process.env.OPENSCOUT_CONTROL_PLANE_DB?.trim();
  if (explicit) return explicit;
  const controlHome =
    process.env.OPENSCOUT_CONTROL_HOME ??
    join(homedir(), ".openscout", "control-plane");
  return join(controlHome, "control-plane.sqlite");
}

function getDb() {
  if (!_db) {
    // create: true matches the runtime's SqliteStore convention. The control
    // plane DB always exists by the time the web server boots (the broker
    // creates it), so the flag is effectively a no-op — but bun:sqlite
    // requires either `create: true` or an explicit readwrite mode.
    _db = new Database(resolveDbPath(), { create: true });
    _db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};`);
    _db.exec("PRAGMA journal_mode = WAL;");
    _db.exec("PRAGMA synchronous = NORMAL;");
    // SCO-037 step 3: ensure the markdown column exists on databases
    // provisioned before schema v8. The runtime now owns this backfill
    // (CONTROL_PLANE_SCHEMA_MIGRATIONS entry "briefings-markdown-column");
    // this web-side copy stays one release as a belt while older runtimes
    // are still in the field, then gets removed.
    ensureBriefingsMarkdownColumn(_db);
    _drizzle = openControlPlaneDrizzle(_db);
  }
  return _drizzle!;
}

function ensureBriefingsMarkdownColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info('briefings')").all() as { name: string }[];
    if (!cols.some((c) => c.name === "markdown")) {
      db.exec("ALTER TABLE briefings ADD COLUMN markdown TEXT;");
    }
  } catch {
    // If briefings doesn't exist yet, the broker's startup will create it
    // with the column already present. Swallow — getDb() will be called
    // again once the table is in place.
  }
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
  _db?.close();
  _db = null;
  _drizzle = null;
}
