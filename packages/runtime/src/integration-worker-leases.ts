import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

export const INTEGRATION_WORKER_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS integration_worker_leases (
  operation_id TEXT PRIMARY KEY REFERENCES integration_setup_operations(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'connected', 'stopped')),
  updated_at INTEGER NOT NULL
);
`;
export interface IntegrationWorkerGrant {
  operationId: string;
  generation: number;
  token: string;
  expiresAt: number;
}
export interface IntegrationWorkerObservation {
  generation: number;
  state: "starting" | "connected" | "stopped" | "expired";
  expiresAt: number;
  updatedAt: number;
}
type LeaseRow = { operation_id: string; owner_id: string; generation: number; token_hash: string; expires_at: number; state: "starting" | "connected" | "stopped"; updated_at: number };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Leases fence worker IO, not process existence. A supervisor must still reap
 * its known old child before starting a replacement. Tokens never enter status.
 */
export class IntegrationWorkerLeases {
  constructor(private readonly database: ControlPlaneSqliteTransactionalDatabase, private readonly ownerId = randomUUID(), private readonly now = Date.now) {}
  private row(operationId: string): LeaseRow | null {
    return this.database.query<LeaseRow>("SELECT * FROM integration_worker_leases WHERE operation_id = ?1").get(operationId);
  }
  observe(operationId: string): IntegrationWorkerObservation | undefined {
    const row = this.row(operationId);
    if (!row) return;
    return { generation: row.generation, state: row.state === "stopped" ? "stopped" : (row.owner_id !== this.ownerId || row.expires_at <= this.now()) ? "expired" : row.state, expiresAt: row.expires_at, updatedAt: row.updated_at };
  }
  claim(operationId: string, ttlMs = 20_000): IntegrationWorkerGrant {
    this.validateTtl(ttlMs);
    return this.database.transaction(() => {
      const prior = this.row(operationId);
      const now = this.now();
      if (prior && prior.state !== "stopped" && prior.expires_at > now) throw new Error("Integration worker lease is still active.");
      const token = randomUUID();
      const generation = (prior?.generation ?? 0) + 1;
      const expiresAt = now + ttlMs;
      this.database.query(`INSERT INTO integration_worker_leases (operation_id, owner_id, generation, token_hash, expires_at, state, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'starting', ?6)
        ON CONFLICT(operation_id) DO UPDATE SET owner_id = excluded.owner_id, generation = excluded.generation,
          token_hash = excluded.token_hash, expires_at = excluded.expires_at, state = excluded.state, updated_at = excluded.updated_at`)
        .run(operationId, this.ownerId, generation, hash(token), expiresAt, now);
      return { operationId, generation, token, expiresAt };
    })();
  }
  authorize(grant: Pick<IntegrationWorkerGrant, "operationId" | "generation" | "token">): void {
    const row = this.row(grant.operationId);
    if (!row || row.owner_id !== this.ownerId || row.generation !== grant.generation || row.state === "stopped" || row.expires_at <= this.now()
      || typeof grant.token !== "string" || grant.token.length > 256
      || !timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(hash(grant.token), "hex"))) {
      throw new Error("Integration worker lease is expired or revoked.");
    }
  }
  renew(grant: IntegrationWorkerGrant, connected: boolean, ttlMs = 20_000): IntegrationWorkerGrant {
    this.validateTtl(ttlMs);
    return this.database.transaction(() => {
      this.authorize(grant);
      const now = this.now();
      const expiresAt = now + ttlMs;
      this.database.query("UPDATE integration_worker_leases SET expires_at = ?1, state = ?2, updated_at = ?3 WHERE operation_id = ?4 AND generation = ?5")
        .run(expiresAt, connected ? "connected" : "starting", now, grant.operationId, grant.generation);
      return { ...grant, expiresAt };
    })();
  }
  release(grant: IntegrationWorkerGrant): void {
    const now = this.now();
    this.database.query("UPDATE integration_worker_leases SET state = 'stopped', expires_at = ?1, updated_at = ?1 WHERE operation_id = ?2 AND owner_id = ?3 AND generation = ?4 AND token_hash = ?5")
      .run(now, grant.operationId, this.ownerId, grant.generation, hash(grant.token));
  }
  revoke(operationId: string): void {
    const now = this.now();
    this.database.query("UPDATE integration_worker_leases SET state = 'stopped', expires_at = ?1, updated_at = ?1 WHERE operation_id = ?2").run(now, operationId);
  }
  private validateTtl(ttl: number): void {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 60_000) throw new Error("Worker lease TTL must be between one and sixty seconds.");
  }
}
