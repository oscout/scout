import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  archiveEvents,
  ensureDurableDirectory,
  evaluateControlPlaneVacuum,
  isoWeekLabel,
  VACUUM_FREELIST_THRESHOLD_BYTES,
} from "./control-plane-archive.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    node_id TEXT,
    ts INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`);
  return db;
}

function insertEvent(
  db: Database,
  id: string,
  ts: number,
  kind = "agent.endpoint.upserted",
): void {
  db.query(
    "INSERT INTO events (id, kind, actor_id, node_id, ts, payload_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(id, kind, "actor-1", "node-1", ts, JSON.stringify({ id }));
}

function readGzipLines(path: string): Record<string, unknown>[] {
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every published (non-*.tmp) archive file, recursively, sorted. */
function publishedFiles(eventsDir: string): string[] {
  if (!readdirSync(eventsDir, { withFileTypes: true }).length) return [];
  const files: string[] = [];
  for (const weekDir of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!weekDir.isDirectory()) continue;
    for (const file of readdirSync(join(eventsDir, weekDir.name))) {
      if (!file.endsWith(".tmp")) {
        files.push(join(weekDir.name, file));
      }
    }
  }
  return files.sort();
}

/** Every leftover *.tmp file, recursively. */
function tempFiles(eventsDir: string): string[] {
  const files: string[] = [];
  for (const weekDir of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!weekDir.isDirectory()) continue;
    for (const file of readdirSync(join(eventsDir, weekDir.name))) {
      if (file.endsWith(".tmp")) files.push(join(weekDir.name, file));
    }
  }
  return files.sort();
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
// A fixed Monday (UTC) so ts arithmetic lands inside ISO weeks.
const T0 = Date.UTC(2026, 5, 29, 12); // 2026-06-29 noon UTC — ISO 2026-W27

/** The deterministic page filename for a page holding `ids` in page order. */
function pageFileName(firstTs: number, lastTs: number, ids: string[]): string {
  const hash = createHash("sha256");
  for (const id of ids) {
    hash.update(id);
    hash.update("\n");
  }
  return `${firstTs}-${lastTs}-${ids.length}-${hash.digest("hex").slice(0, 16)}.jsonl.gz`;
}

describe("isoWeekLabel", () => {
  test("labels ISO weeks including year boundaries", () => {
    expect(isoWeekLabel(Date.UTC(2026, 5, 29))).toBe("2026-W27"); // Monday
    expect(isoWeekLabel(Date.UTC(2026, 6, 5))).toBe("2026-W27");  // Sunday same week
    expect(isoWeekLabel(Date.UTC(2026, 6, 6))).toBe("2026-W28");  // next Monday
    expect(isoWeekLabel(Date.UTC(2025, 11, 29))).toBe("2026-W01"); // Dec 29 → ISO year 2026
    expect(isoWeekLabel(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeekLabel(Date.UTC(2024, 0, 1))).toBe("2024-W01");
  });
});

describe("archiveEvents", () => {
  test("archives pre-cutoff rows into immutable per-week page files and prunes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    // Weeks 4-7 fall below the cutoff; a boundary row at exactly the cutoff
    // stays behind.
    const cutoff = T0 - 4 * WEEK + 1;
    for (let week = 0; week < 8; week += 1) {
      insertEvent(db, `ev-w${week}`, T0 - week * WEEK, `kind.${week % 3}`);
    }
    // Multiple rows in one week to exercise grouping.
    insertEvent(db, "ev-w5b", T0 - 5 * WEEK + 3_600_000);
    // At/after the cutoff: untouched.
    insertEvent(db, "ev-boundary", cutoff);
    insertEvent(db, "ev-live", T0);

    const result = await archiveEvents(db, { cutoff, archiveDir: root });

    expect(result.rows).toBe(5);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.weeks).toEqual([
      isoWeekLabel(T0 - 7 * WEEK),
      isoWeekLabel(T0 - 6 * WEEK),
      isoWeekLabel(T0 - 5 * WEEK),
      isoWeekLabel(T0 - 4 * WEEK),
    ]);

    // One immutable page file per week, named
    // <firstTs>-<lastTs>-<count>-<idHash16>.
    const files = publishedFiles(join(root, "events"));
    expect(files).toEqual([
      `${isoWeekLabel(T0 - 7 * WEEK)}/${pageFileName(T0 - 7 * WEEK, T0 - 7 * WEEK, ["ev-w7"])}`,
      `${isoWeekLabel(T0 - 6 * WEEK)}/${pageFileName(T0 - 6 * WEEK, T0 - 6 * WEEK, ["ev-w6"])}`,
      `${isoWeekLabel(T0 - 5 * WEEK)}/${pageFileName(T0 - 5 * WEEK, T0 - 5 * WEEK + 3_600_000, ["ev-w5", "ev-w5b"])}`,
      `${isoWeekLabel(T0 - 4 * WEEK)}/${pageFileName(T0 - 4 * WEEK, T0 - 4 * WEEK, ["ev-w4"])}`,
    ].sort());

    const oldest = readGzipLines(join(root, "events", files.find((f) => f.startsWith(isoWeekLabel(T0 - 7 * WEEK)))!));
    expect(oldest.map((row) => row.id)).toEqual(["ev-w7"]);
    expect(oldest[0]).toMatchObject({ kind: "kind.1", actor_id: "actor-1", node_id: "node-1", ts: T0 - 7 * WEEK });

    const grouped = readGzipLines(join(root, "events", files.find((f) => f.startsWith(isoWeekLabel(T0 - 5 * WEEK)))!));
    expect(grouped.map((row) => row.id)).toEqual(["ev-w5", "ev-w5b"]);

    const remaining = new Set(
      db.query<{ id: string }>("SELECT id FROM events").all().map((row) => row.id),
    );
    expect(remaining).toEqual(new Set(["ev-boundary", "ev-live", "ev-w3", "ev-w2", "ev-w1", "ev-w0"]));
  });

  test("a second run archives nothing for already-deleted rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const cutoff = T0 - 4 * WEEK;
    insertEvent(db, "ev-old", T0 - 6 * WEEK);
    insertEvent(db, "ev-live", T0);

    const first = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(first.rows).toBe(1);

    const second = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(second).toEqual({ rows: 0, bytesWritten: 0, weeks: [] });

    // The published file still holds exactly the one archived row.
    const files = publishedFiles(join(root, "events"));
    expect(files).toEqual([`${isoWeekLabel(T0 - 6 * WEEK)}/${pageFileName(T0 - 6 * WEEK, T0 - 6 * WEEK, ["ev-old"])}`]);
    expect(readGzipLines(join(root, "events", files[0]))).toHaveLength(1);
  });

  test("a page failure keeps earlier pages deleted and later rows intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const cutoff = T0 - 2 * WEEK;
    const pageSize = 4;
    // 9 doomed rows → 3 pages of 4/4/1; fail the second page's first write.
    for (let index = 0; index < 9; index += 1) {
      insertEvent(db, `ev-${index}`, cutoff - (index + 1) * 3_600_000);
    }
    insertEvent(db, "ev-live", T0);

    let writes = 0;
    let pagesWritten = 0;
    await expect(archiveEvents(db, {
      cutoff,
      archiveDir: root,
      pageSize,
      writePage: async (filePath, lines) => {
        writes += 1;
        if (writes === 2) {
          throw new Error("injected archive write failure");
        }
        pagesWritten += 1;
        writeFileSync(filePath, gzipSync(lines.join("")));
        return statSync(filePath).size;
      },
    })).rejects.toThrow("injected archive write failure");

    // Page 1 (the 4 oldest rows) archived + deleted; pages 2-3 untouched.
    const remaining = db.query<{ id: string }>("SELECT id FROM events ORDER BY ts").all().map((row) => row.id);
    expect(remaining).toEqual(["ev-4", "ev-3", "ev-2", "ev-1", "ev-0", "ev-live"]);
    expect(pagesWritten).toBe(1);
    // The failed write never reached publication.
    expect(publishedFiles(join(root, "events"))).toHaveLength(1);
  });

  test("a partial gzip write leaves no unreadable published file and the retry succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const old = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;
    insertEvent(db, "ev-old", old);
    insertEvent(db, "ev-live", T0);

    // Simulate an interrupted/ENOSPC write: half a gzip member to the temp
    // path, then a throw. Publication must not happen, rows must survive.
    let tempPath = "";
    await expect(archiveEvents(db, {
      cutoff,
      archiveDir: root,
      writePage: async (filePath, lines) => {
        tempPath = filePath;
        mkdirSync(join(root, "events", isoWeekLabel(old)), { recursive: true });
        const bytes = gzipSync(lines.join(""));
        writeFileSync(filePath, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw new Error("injected ENOSPC after partial write");
      },
    })).rejects.toThrow("injected ENOSPC after partial write");

    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(2);
    expect(publishedFiles(join(root, "events"))).toEqual([]);
    // The only artifact is the unpublished temp file.
    expect(tempFiles(join(root, "events"))).toHaveLength(1);
    expect(tempPath.endsWith(".tmp")).toBe(true);

    // Retry with the real writer: the page archives cleanly and the row goes.
    const retry = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(retry.rows).toBe(1);
    const files = publishedFiles(join(root, "events"));
    expect(files).toEqual([`${isoWeekLabel(old)}/${pageFileName(old, old, ["ev-old"])}`]);
    // Every published file gunzips.
    expect(readGzipLines(join(root, "events", files[0])).map((row) => row.id)).toEqual(["ev-old"]);
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(1);
  });

  test("a page published but not deleted re-archives under the same name without corruption", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const old = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;
    insertEvent(db, "ev-old", old);
    insertEvent(db, "ev-live", T0);

    // Simulate a crash between publish and delete by re-inserting the row
    // after a successful run — the page is already on disk but the row is
    // still in the table, so the next run re-archives it.
    const first = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(first.rows).toBe(1);
    insertEvent(db, "ev-old", old);

    const second = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(second.rows).toBe(1);
    // Identical committed page: the write is skipped (idempotent re-archive)
    // but the rows are still deleted.
    expect(second.bytesWritten).toBe(0);
    // Deterministic name: still exactly one published file, still valid.
    const files = publishedFiles(join(root, "events"));
    expect(files).toEqual([`${isoWeekLabel(old)}/${pageFileName(old, old, ["ev-old"])}`]);
    expect(readGzipLines(join(root, "events", files[0])).map((row) => row.id)).toEqual(["ev-old"]);
  });

  // Third-pass durability: an already-committed page may be the debris of a
  // publish that died before its fsync barriers. Existence is not proof —
  // the identical-page path must fsync the file and its directory before
  // the source rows are deleted, and a failed fsync keeps the rows.
  test("an identical committed page is fsynced before its rows are deleted — a failed fsync keeps them", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const old = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;
    insertEvent(db, "ev-old", old);

    const first = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(first.rows).toBe(1);
    // The committed page exists; the row comes back (crash between publish
    // and delete).
    insertEvent(db, "ev-old", old);

    // Fail exactly the fsync on the page FILE — directory fsyncs pass.
    const pageFds = new Set<number>();
    let failPageFsync = true;
    const fsx = {
      existsSync,
      mkdirSync,
      openSync: (path: string, flags: string) => {
        const fd = openSync(path, flags);
        if (path.endsWith(".jsonl.gz")) pageFds.add(fd);
        return fd;
      },
      fsyncSync: (fd: number) => {
        if (failPageFsync && pageFds.has(fd)) {
          throw new Error("injected page fsync failure");
        }
        fsyncSync(fd);
      },
      closeSync,
    };
    await expect(archiveEvents(db, { cutoff, archiveDir: root, fsx }))
      .rejects.toThrow("injected page fsync failure");
    // The rows stay — the page's durability was never proven.
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(1);

    failPageFsync = false;
    const retry = await archiveEvents(db, { cutoff, archiveDir: root, fsx });
    expect(retry.rows).toBe(1);
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(0);
  });

  test("stale temp files are reaped by age while fresh ones survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const cutoff = T0 - 4 * WEEK;
    const eventsDir = join(root, "events");
    const weekDir = join(eventsDir, isoWeekLabel(T0 - 6 * WEEK));
    mkdirSync(weekDir, { recursive: true });

    const staleTmp = join(weekDir, "stale.jsonl.gz.tmp");
    const freshTmp = join(weekDir, "fresh.jsonl.gz.tmp");
    writeFileSync(staleTmp, "partial");
    writeFileSync(freshTmp, "partial");
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);

    insertEvent(db, "ev-live", T0);
    await archiveEvents(db, { cutoff, archiveDir: root });

    expect(tempFiles(eventsDir)).toEqual([`${isoWeekLabel(T0 - 6 * WEEK)}/fresh.jsonl.gz.tmp`]);
    expect(statSync(freshTmp).size).toBe(7);
  });

  test("pages archive in ts order with the real gzip writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const cutoff = T0 - WEEK;
    const timestamps: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const ts = cutoff - (index + 1) * 3_600_000;
      timestamps.push(ts);
      insertEvent(db, `ev-${index}`, ts);
    }
    const result = await archiveEvents(db, { cutoff, archiveDir: root, pageSize: 2 });
    expect(result.rows).toBe(5);

    // 5 rows / 2 per page → three immutable page files, each named by its
    // first/last ts, row count, and the hash of its canonical row ids.
    // Together they cover oldest → newest.
    const files = publishedFiles(join(root, "events"));
    const week = isoWeekLabel(timestamps[0]);
    expect(files).toEqual([
      `${week}/${pageFileName(timestamps[4], timestamps[3], ["ev-4", "ev-3"])}`,
      `${week}/${pageFileName(timestamps[2], timestamps[1], ["ev-2", "ev-1"])}`,
      `${week}/${pageFileName(timestamps[0], timestamps[0], ["ev-0"])}`,
    ].sort());
    const allRows = files.flatMap((file) => readGzipLines(join(root, "events", file)).map((row) => row.id));
    expect(allRows.sort()).toEqual(["ev-0", "ev-1", "ev-2", "ev-3", "ev-4"]);
  });

  // Regression: PR #986 second pass P1a — <firstTs>-<lastTs>-<rowCount> is
  // not a page identity; same-timestamp pages used to collide and overwrite.
  test("same-timestamp pages get distinct names and every row survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const ts = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;
    // Four rows at ONE timestamp with pageSize 2 → two pages that would have
    // shared the name <ts>-<ts>-2.jsonl.gz before id-hashing.
    for (let index = 0; index < 4; index += 1) {
      insertEvent(db, `tie${index}`, ts);
    }

    const result = await archiveEvents(db, { cutoff, archiveDir: root, pageSize: 2 });
    expect(result.rows).toBe(4);

    const files = publishedFiles(join(root, "events"));
    const week = isoWeekLabel(ts);
    expect(files).toEqual([
      `${week}/${pageFileName(ts, ts, ["tie0", "tie1"])}`,
      `${week}/${pageFileName(ts, ts, ["tie2", "tie3"])}`,
    ].sort());
    const archived = files.flatMap((file) => readGzipLines(join(root, "events", file)).map((row) => row.id));
    expect(archived.sort()).toEqual(["tie0", "tie1", "tie2", "tie3"]);
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(0);
  });

  // Regression: late-arriving rows for an already-archived week must land in
  // a NEW page file — the committed one is never extended or overwritten.
  test("late-arriving rows for an archived week produce a new page file across runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const ts = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;

    insertEvent(db, "early", ts);
    const first = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(first.rows).toBe(1);

    insertEvent(db, "late", ts);
    const second = await archiveEvents(db, { cutoff, archiveDir: root });
    expect(second.rows).toBe(1);

    const week = isoWeekLabel(ts);
    const files = publishedFiles(join(root, "events"));
    expect(files).toEqual([
      `${week}/${pageFileName(ts, ts, ["early"])}`,
      `${week}/${pageFileName(ts, ts, ["late"])}`,
    ].sort());
    // The originally committed page still holds exactly its own row.
    const earlyPage = files.find((file) => file.includes(pageFileName(ts, ts, ["early"])))!;
    expect(readGzipLines(join(root, "events", earlyPage)).map((row) => row.id)).toEqual(["early"]);
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(0);
  });

  // Regression: a committed page whose name matches but whose content does
  // NOT is a bug — refuse, and leave every row in SQLite.
  test("a conflicting committed page fails without deleting rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const db = createDb();
    const old = T0 - 6 * WEEK;
    const cutoff = T0 - 4 * WEEK;
    insertEvent(db, "ev-old", old);

    // Pre-commit a DIFFERENT payload under the exact name ev-old's page
    // would take — the content-hash check must catch it.
    const weekDir = join(root, "events", isoWeekLabel(old));
    mkdirSync(weekDir, { recursive: true });
    writeFileSync(
      join(weekDir, pageFileName(old, old, ["ev-old"])),
      gzipSync(`${JSON.stringify({ id: "foreign", ts: old })}\n`),
    );

    await expect(archiveEvents(db, { cutoff, archiveDir: root }))
      .rejects.toThrow(/refusing to overwrite/);
    expect(db.query<{ n: number }>("SELECT count(*) n FROM events").get()!.n).toBe(1);
    // The committed page is untouched.
    expect(readGzipLines(join(root, "events", `${isoWeekLabel(old)}/${pageFileName(old, old, ["ev-old"])}`))
      .map((row) => row.id)).toEqual(["foreign"]);
  });
});

describe("ensureDurableDirectory", () => {
  test("fsyncs the parent of every path component, existing or not", () => {
    const existing = new Set(["/base"]);
    const created: string[] = [];
    const fsyncedParents: string[] = [];
    let nextFd = 100;
    const openedByFd = new Map<number, string>();
    ensureDurableDirectory("/base/events/2026-W27", {
      existsSync: (path) => existing.has(path),
      mkdirSync: (path) => { created.push(path); existing.add(path); },
      openSync: (path) => { openedByFd.set(nextFd, path); return nextFd++; },
      fsyncSync: (fd) => { fsyncedParents.push(openedByFd.get(fd)!); },
      closeSync: () => {},
    });
    expect(created).toEqual(["/base/events", "/base/events/2026-W27"]);
    // Every component's parent is fsynced — including the already-existing
    // /base (whose parent is /). There is no existing-dir short-circuit.
    expect(fsyncedParents).toEqual(["/", "/base", "/base/events"]);
  });

  // Third-pass durability: a failed fsync leaves no marker — a retry must
  // re-establish every parent's barrier instead of short-circuiting on the
  // directories the failed call did manage to create.
  test("a failed fsync is retried — existing directories get their barriers on the next call", () => {
    const existing = new Set(["/"]);
    let failFsyncs = 1;
    const fsynced: string[] = [];
    let nextFd = 1;
    const openedByFd = new Map<number, string>();
    const fsx = {
      existsSync: (path: string) => existing.has(path),
      mkdirSync: (path: string) => { existing.add(path); },
      openSync: (path: string) => { openedByFd.set(nextFd, path); return nextFd++; },
      fsyncSync: (fd: number) => {
        if (failFsyncs > 0) {
          failFsyncs -= 1;
          throw new Error("injected fsync failure");
        }
        fsynced.push(openedByFd.get(fd)!);
      },
      closeSync: () => {},
    };

    expect(() => ensureDurableDirectory("/base/events", fsx))
      .toThrow("injected fsync failure");
    // The mkdirs ran but durability was never proven. The retry fsyncs every
    // parent again even though both directories now exist.
    expect(() => ensureDurableDirectory("/base/events", fsx)).not.toThrow();
    expect(fsynced).toEqual(["/", "/base"]);
  });

  test("creates nested directories on the real filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const deep = join(root, "events", "2026-W27");
    ensureDurableDirectory(deep);
    expect(statSync(deep).isDirectory()).toBe(true);
    // Idempotent on existing paths.
    ensureDurableDirectory(deep);
  });
});

describe("evaluateControlPlaneVacuum", () => {
  test("skips vacuum when the freelist is below the threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-archive-"));
    roots.add(root);
    const dbPath = join(root, "control-plane.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (id TEXT)");
    db.query("INSERT INTO t VALUES ('x')").run();

    const check = evaluateControlPlaneVacuum(db, dbPath);
    expect(check.shouldVacuum).toBe(false);
    expect(check.freelistBytes).toBeLessThan(VACUUM_FREELIST_THRESHOLD_BYTES);
    expect(check.reason).toContain("freelist");
    db.close();
  });
});
