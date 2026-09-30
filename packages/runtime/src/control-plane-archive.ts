import { openSync, closeSync, existsSync, fsyncSync, statSync, statfsSync, mkdirSync, createWriteStream, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createGzip, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { ControlPlaneSqliteDatabase, ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { controlPlaneArchiveDirectory } from "./support-paths.js";

/**
 * Archive-then-prune for the control-plane `events` table. Rows older than
 * the week-clock cutoff are exported to immutable gzip JSONL page files —
 * one file per (page × ISO week) under
 * `<archiveDir>/events/<YYYY>-W<ww>/<firstTs>-<lastTs>-<rowCount>-<idHash16>.jsonl.gz`
 * where idHash is the first 16 hex of the SHA-256 over the page's canonical
 * row ids. Two pages are never given the same name unless they hold the
 * same rows, so an already-published file can be verified instead of
 * silently overwritten.
 *
 * Publication is atomic and happens before any delete: each page's lines go
 * to a `*.tmp` file in the same directory, are fsynced, atomically renamed
 * to the final name, and the directory is fsynced — only then are the
 * page's rows deleted in a transaction. If a file with the target name
 * already exists, its content is compared to the page's: identical means
 * this is an idempotent re-archive (skip the write, still delete the rows);
 * different means a committed page would be clobbered — refuse and leave
 * the rows in SQLite. A crash leaves at worst a stray `*.tmp` (reaped when
 * older than an hour) or re-archives an identical page — archive is
 * at-least-once, never partial: every published file is complete and
 * readable.
 */

export const EVENTS_ARCHIVE_PAGE_SIZE = 10_000;
/** Stale `*.tmp` publication leftovers are reaped once older than this. */
export const ARCHIVE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Run VACUUM only when the prune freed at least this much of the file. */
export const VACUUM_FREELIST_THRESHOLD_BYTES = 256 * 1024 * 1024;
/** …and only when free disk can hold the compacted copy twice over. */
export const VACUUM_DISK_HEADROOM_FACTOR = 2;

export type EventsArchivePageWriter = (
  filePath: string,
  lines: string[],
) => Promise<number>;

export type ArchiveEventsOptions = {
  cutoff: number;
  archiveDir?: string;
  pageSize?: number;
  /**
   * Injectable for tests; defaults to gzip JSONL write + fsync. Called with
   * the `*.tmp` path — the module owns rename and directory fsync, so a
   * throwing writer can never publish a partial file.
   */
  writePage?: EventsArchivePageWriter;
  /** `*.tmp` reaping age override for tests. */
  tempMaxAgeMs?: number;
  /**
   * Injectable filesystem surface for directory/existing-page fsync
   * barriers — tests drive failed-fsync retries through it.
   */
  fsx?: ArchiveDirFs;
};

export type ArchiveEventsResult = {
  rows: number;
  /** Bytes published to archive files this run (compressed size on disk). */
  bytesWritten: number;
  /** ISO week labels that received at least one row. */
  weeks: string[];
};

type EventRow = {
  id: string;
  kind: string;
  actor_id: string;
  node_id: string | null;
  ts: number;
  payload_json: string;
};

/** ISO-8601 week label in UTC — archive filenames must not drift with machine TZ. */
export function isoWeekLabel(ts: number): string {
  const date = new Date(ts);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  utc.setUTCDate(utc.getUTCDate() + 4 - day); // Thursday of this ISO week
  const weekYear = utc.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** Write a complete gzip JSONL file (one JSON object per line), fsync, return size. */
async function writeGzipJsonlFile(filePath: string, lines: string[]): Promise<number> {
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "w");
  try {
    // The stream must not own the fd — fsync happens after the gzip trailer.
    const output = createWriteStream("", { fd, autoClose: false });
    await pipeline(Readable.from(lines.join("")), createGzip(), output);
    fsyncSync(fd);
    return statSync(filePath).size;
  } finally {
    closeSync(fd);
  }
}

/** Atomically publish a fully-written temp file, then fsync its directory. */
function publishArchivePage(tempPath: string, finalPath: string): void {
  renameSync(tempPath, finalPath);
  const fd = openSync(dirname(finalPath), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Minimal fs surface so directory durability can be exercised with a fake. */
export type ArchiveDirFs = {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string) => unknown;
  openSync: (path: string, flags: string) => number;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
};

const REAL_ARCHIVE_DIR_FS: ArchiveDirFs = {
  existsSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
};

/**
 * Create `dirPath` durably and prove it: walk every component from the
 * filesystem root down, mkdir what is missing, and fsync each component's
 * parent so the link survives a crash. There is deliberately no
 * existing-directory short-circuit — a failed fsync leaves no marker, so
 * an earlier run whose mkdir succeeded but whose fsync died must still get
 * its durability barrier on the retry. Only then are the archive files
 * inside it considered safe to publish (and source rows safe to delete).
 */
export function ensureDurableDirectory(
  dirPath: string,
  fsx: ArchiveDirFs = REAL_ARCHIVE_DIR_FS,
): void {
  const chain: string[] = [];
  let current = dirPath;
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    chain.unshift(current);
    current = parent;
  }
  for (const dir of chain) {
    if (!fsx.existsSync(dir)) {
      fsx.mkdirSync(dir);
    }
    const fd = fsx.openSync(dirname(dir), "r");
    try {
      fsx.fsyncSync(fd);
    } finally {
      fsx.closeSync(fd);
    }
  }
}

/**
 * fsync a file and its containing directory. A committed page whose name
 * already exists may be the debris of a publish that died before its fsync
 * barriers — the row delete below must not trust mere existence.
 */
function fsyncPublishedPage(finalPath: string, fsx: ArchiveDirFs): void {
  const fd = fsx.openSync(finalPath, "r");
  try {
    fsx.fsyncSync(fd);
  } finally {
    fsx.closeSync(fd);
  }
  const dirFd = fsx.openSync(dirname(finalPath), "r");
  try {
    fsx.fsyncSync(dirFd);
  } finally {
    fsx.closeSync(dirFd);
  }
}

/** First 16 hex of SHA-256 over the page's canonical row ids — the page identity. */
function archivePageIdHash(rows: readonly { id: string }[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(row.id);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Delete `*.tmp` leftovers older than `maxAgeMs` — publication crash debris. */
function reapStaleArchiveTemps(eventsDir: string, maxAgeMs: number): void {
  if (!existsSync(eventsDir)) return;
  const now = Date.now();
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const weekDir = join(eventsDir, entry.name);
    for (const file of readdirSync(weekDir)) {
      if (!file.endsWith(".tmp")) continue;
      const tempPath = join(weekDir, file);
      try {
        if (now - statSync(tempPath).mtimeMs >= maxAgeMs) {
          unlinkSync(tempPath);
        }
      } catch {
        // Best-effort housekeeping — a vanished file is not a failure.
      }
    }
  }
}

function isTransactional(
  db: ControlPlaneSqliteDatabase,
): db is ControlPlaneSqliteTransactionalDatabase {
  return typeof (db as ControlPlaneSqliteTransactionalDatabase).transaction === "function";
}

/**
 * Archive every `events` row with `ts < cutoff` into immutable per-page
 * gzip files and delete each successfully published page inside a
 * transaction.
 *
 * Page-level failure semantics: pages already published keep their deletes
 * (the work is durable on disk); the failing page publishes nothing and its
 * rows — plus everything after it — stay in the table. A second run
 * archives exactly the rows that remain; a page that was published but not
 * deleted is re-archived under the same deterministic filename, so
 * at-least-once publication cannot produce duplicates or corrupt files.
 */
export async function archiveEvents(
  db: ControlPlaneSqliteDatabase,
  options: ArchiveEventsOptions,
): Promise<ArchiveEventsResult> {
  const archiveDir = options.archiveDir ?? controlPlaneArchiveDirectory();
  const pageSize = options.pageSize ?? EVENTS_ARCHIVE_PAGE_SIZE;
  const writePage = options.writePage ?? writeGzipJsonlFile;
  const fsx = options.fsx ?? REAL_ARCHIVE_DIR_FS;

  const eventsDir = join(archiveDir, "events");
  ensureDurableDirectory(eventsDir, fsx);
  reapStaleArchiveTemps(eventsDir, options.tempMaxAgeMs ?? ARCHIVE_TEMP_MAX_AGE_MS);

  const result: ArchiveEventsResult = { rows: 0, bytesWritten: 0, weeks: [] };
  const seenWeeks = new Set<string>();
  const selectPage = db.query<EventRow>(
    "SELECT id, kind, actor_id, node_id, ts, payload_json FROM events WHERE ts < ?1 ORDER BY ts, id LIMIT ?2",
  );
  const deleteRow = db.query("DELETE FROM events WHERE id = ?1");

  while (true) {
    const page = selectPage.all(options.cutoff, pageSize);
    if (page.length === 0) break;

    // Group the page into per-week row batches; every batch is published
    // (write → fsync → rename → directory fsync) before any row is deleted.
    const rowsByWeek = new Map<string, EventRow[]>();
    for (const row of page) {
      const week = isoWeekLabel(row.ts);
      const rows = rowsByWeek.get(week) ?? [];
      rows.push(row);
      rowsByWeek.set(week, rows);
    }

    for (const [week, rows] of rowsByWeek) {
      const weekDir = join(eventsDir, week);
      ensureDurableDirectory(weekDir, fsx);
      const fileName = `${rows[0].ts}-${rows[rows.length - 1].ts}-${rows.length}-${archivePageIdHash(rows)}.jsonl.gz`;
      const tempPath = join(weekDir, `${fileName}.tmp`);
      const finalPath = join(weekDir, fileName);
      const pageLines = rows.map((row) => JSON.stringify(row) + "\n");
      if (existsSync(finalPath)) {
        // A page with this exact name is already committed. Identical
        // content means an idempotent re-archive — skip the write and let
        // the rows be deleted below. Different content would mean the
        // committed page is about to be clobbered: refuse loudly instead.
        let identical = false;
        try {
          identical = gunzipSync(readFileSync(finalPath)).toString("utf8")
            === pageLines.join("");
        } catch {
          identical = false;
        }
        if (!identical) {
          throw new Error(
            `control-plane archive collision at ${finalPath}: ` +
            "a different committed page exists; refusing to overwrite",
          );
        }
        // Existence is not durability: a prior publish may have died
        // between rename and its fsync barriers. Prove the file's bytes
        // and the directory link are on disk before rows are deleted.
        fsyncPublishedPage(finalPath, fsx);
      } else {
        result.bytesWritten += await writePage(tempPath, pageLines);
        publishArchivePage(tempPath, finalPath);
      }
      seenWeeks.add(week);
    }

    if (isTransactional(db)) {
      db.transaction(() => {
        for (const row of page) {
          deleteRow.run(row.id);
        }
      })();
    } else {
      // The adapter is synchronous; without a transaction helper still keep
      // the delete explicit and ordered.
      db.exec("BEGIN IMMEDIATE;");
      try {
        for (const row of page) {
          deleteRow.run(row.id);
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
    }
    result.rows += page.length;

    // A short final page ends the run; a full page may have more to do.
    if (page.length < pageSize) break;
  }

  result.weeks = [...seenWeeks].sort();
  return result;
}

export type ControlPlaneVacuumCheck = {
  freelistBytes: number;
  dbBytes: number;
  freeDiskBytes: number | null;
  shouldVacuum: boolean;
  reason: string;
};

/**
 * Decide whether a post-prune VACUUM is worth it: only when the freelist freed
 * ≥ 256 MB AND free disk can hold a second full copy of the database.
 * The caller owns serialization — run the VACUUM inside `runWrite`, never
 * alongside broker writes.
 */
export function evaluateControlPlaneVacuum(
  db: ControlPlaneSqliteDatabase,
  dbPath: string,
): ControlPlaneVacuumCheck {
  const pageSize = db.query<{ page_size: number }>("PRAGMA page_size").get()?.page_size ?? 0;
  const freelistCount = db.query<{ freelist_count: number }>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
  const freelistBytes = pageSize * freelistCount;
  const dbBytes = statSync(dbPath).size;
  let freeDiskBytes: number | null = null;
  try {
    const fs = statfsSync(dirname(dbPath));
    freeDiskBytes = fs.bavail * fs.bsize;
  } catch {
    freeDiskBytes = null;
  }

  if (freelistBytes < VACUUM_FREELIST_THRESHOLD_BYTES) {
    return {
      freelistBytes,
      dbBytes,
      freeDiskBytes,
      shouldVacuum: false,
      reason: `freelist ${(freelistBytes / 1024 / 1024).toFixed(1)} MiB below ${VACUUM_FREELIST_THRESHOLD_BYTES / 1024 / 1024} MiB threshold`,
    };
  }
  if (freeDiskBytes === null) {
    return {
      freelistBytes,
      dbBytes,
      freeDiskBytes,
      shouldVacuum: false,
      reason: "free disk space could not be measured",
    };
  }
  if (freeDiskBytes < dbBytes * VACUUM_DISK_HEADROOM_FACTOR) {
    return {
      freelistBytes,
      dbBytes,
      freeDiskBytes,
      shouldVacuum: false,
      reason: `free disk ${(freeDiskBytes / 1024 / 1024 / 1024).toFixed(1)} GiB below ${VACUUM_DISK_HEADROOM_FACTOR}× database size ${(dbBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`,
    };
  }
  return {
    freelistBytes,
    dbBytes,
    freeDiskBytes,
    shouldVacuum: true,
    reason: `freelist ${(freelistBytes / 1024 / 1024).toFixed(1)} MiB, free disk sufficient`,
  };
}
