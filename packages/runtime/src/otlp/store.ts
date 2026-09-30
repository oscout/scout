import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { openRuntimeSqliteDatabase, type ControlPlaneSqliteDatabase } from "../sqlite-adapter.js";
import type { OtlpLimits } from "./config.js";
import type { OtlpObservation } from "./sanitize.js";

export class OtlpObservationStore {
  private readonly db: ControlPlaneSqliteDatabase;
  private retentionEvicted = 0;
  private closed = false;

  constructor(path: string, private readonly limits: OtlpLimits, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(path, "wx", 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    this.db = openRuntimeSqliteDatabase(path, { create: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 100; PRAGMA locking_mode = EXCLUSIVE;");
      const appId = this.db.query<{ application_id: number }>("PRAGMA application_id").get()!.application_id;
      const objects = this.db.query<{ count: number }>("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.count;
      const version = this.db.query<{ user_version: number }>("PRAGMA user_version").get()!.user_version;
      if ((appId !== 0x534f544c && (objects > 0 || appId !== 0)) || (version !== 0 && version !== 1)) throw new Error("Not a supported OTLP observation database");
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 128; PRAGMA journal_size_limit = 1048576;");
      const pageSize = this.db.query<{ page_size: number }>("PRAGMA page_size").get()!.page_size;
      const pageLimit = Math.floor(limits.maxDatabaseBytes / pageSize);
      if (pageLimit < 1) throw new Error("OTLP database limit too small");
      const pageCount = this.db.query<{ page_count: number }>("PRAGMA page_count").get()!.page_count;
      if (pageCount > pageLimit) throw new Error("OTLP database exceeds configured limit");
      this.db.exec(`PRAGMA max_page_count = ${pageLimit};`);
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS otlp_observations (
          seq INTEGER PRIMARY KEY, id TEXT NOT NULL, resource_key TEXT NOT NULL,
          received_at INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS otlp_resource_seq ON otlp_observations(resource_key, seq);
        CREATE INDEX IF NOT EXISTS otlp_received ON otlp_observations(received_at);
        PRAGMA application_id = ${0x534f544c}; PRAGMA user_version = 1;`);
      });
      this.cleanup();
    } catch (error) {
      this.db.close?.();
      throw error;
    }
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private prune(): number {
    let evicted = 0;
    const remove = (sql: string, ...args: unknown[]) => {
      this.db.query(sql).run(...args);
      evicted += this.db.query<{ count: number }>("SELECT changes() AS count").get()!.count;
    };
    remove("DELETE FROM otlp_observations WHERE received_at <= ?", this.now() - this.limits.ttlMs);
    remove(`DELETE FROM otlp_observations WHERE seq IN (
      SELECT seq FROM (SELECT seq, row_number() OVER (PARTITION BY resource_key ORDER BY seq DESC) AS rank FROM otlp_observations) WHERE rank > ?
    )`, this.limits.maxResourceRows);
    remove(`DELETE FROM otlp_observations WHERE seq IN (
      SELECT seq FROM (SELECT seq, row_number() OVER (ORDER BY seq DESC) AS rank,
        sum(bytes) OVER (ORDER BY seq DESC) AS total_bytes FROM otlp_observations)
      WHERE rank > ? OR total_bytes > ?
    )`, this.limits.maxRows, this.limits.maxStoreBytes);
    return evicted;
  }

  append(observations: OtlpObservation[]): void {
    let evicted = 0;
    this.transaction(() => {
      evicted += this.prune();
      const insert = this.db.query("INSERT INTO otlp_observations (id, resource_key, received_at, bytes, payload) VALUES (?, ?, ?, ?, ?)");
      for (const observation of observations) {
        const payload = JSON.stringify(observation);
        insert.run(observation.id, observation.resourceKey, observation.receivedAt, Buffer.byteLength(payload), payload);
      }
      evicted += this.prune();
    });
    this.retentionEvicted += evicted;
  }

  recent(limit = 100): OtlpObservation[] {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return this.db.query<{ payload: string }>("SELECT payload FROM otlp_observations WHERE received_at > ? ORDER BY seq DESC LIMIT ?")
      .all(this.now() - this.limits.ttlMs, bounded).reverse().map((row) => JSON.parse(row.payload) as OtlpObservation);
  }

  cleanup(): void {
    let evicted = 0;
    this.transaction(() => { evicted = this.prune(); });
    this.retentionEvicted += evicted;
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  status(): { rows: number; bytes: number; retentionEvicted: number } {
    const row = this.db.query<{ rows: number; bytes: number }>("SELECT count(*) AS rows, coalesce(sum(bytes), 0) AS bytes FROM otlp_observations").get()!;
    return { ...row, retentionEvicted: this.retentionEvicted };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close?.();
  }
}
