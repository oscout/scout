import { afterEach, expect, test } from "bun:test";
import { openControlPlaneSqliteDatabase, type ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { migrateControlPlaneDatabaseSchema } from "./control-plane-migrations.js";
import { IntegrationWorkerLeases } from "./integration-worker-leases.js";
const databases: ControlPlaneSqliteTransactionalDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close?.(); });
function fixture() {
  const database = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  databases.push(database); migrateControlPlaneDatabaseSchema(database);
  database.query("INSERT INTO integration_setup_operations (id,owner_realm_id,scope_key,workspace_key,revision,record_json) VALUES ('op','realm','scope','T1',1,'{}')").run();
  let now = 1000;
  return { database, first: new IntegrationWorkerLeases(database, "first", () => now), second: new IntegrationWorkerLeases(database, "second", () => now), advance: (ms: number) => { now += ms; } };
}
test("only one live generation can be claimed and expired generations cannot revive", () => {
  const f = fixture(); const first = f.first.claim("op");
  expect(() => f.first.claim("op")).toThrow("still active");
  expect(() => f.second.claim("op")).toThrow("still active");
  f.advance(20_001);
  expect(() => f.first.renew(first, true)).toThrow("expired or revoked");
  const next = f.second.claim("op");
  expect(next.generation).toBe(first.generation + 1);
  expect(() => f.first.authorize(first)).toThrow("expired or revoked");
  expect(() => f.second.authorize({ ...next, token: first.token })).toThrow("expired or revoked");
});
test("broker restart invalidates old heartbeats and never reports their connection ready", () => {
  const f = fixture(); const grant = f.first.claim("op"); f.first.renew(grant, true);
  expect(f.first.observe("op")?.state).toBe("connected");
  expect(f.second.observe("op")?.state).toBe("expired");
  expect(() => f.second.renew(grant, true)).toThrow("expired or revoked");
  expect(() => f.second.claim("op")).toThrow("still active");
});
test("revocation fences IO immediately and status does not expose the lease credential", () => {
  const f = fixture(); const grant = f.first.claim("op");
  expect(JSON.stringify(f.first.observe("op"))).not.toContain(grant.token);
  const row = f.database.query<{token_hash: string}>("SELECT token_hash FROM integration_worker_leases").get()!;
  expect(row.token_hash).not.toBe(grant.token);
  f.first.revoke("op");
  expect(() => f.first.authorize(grant)).toThrow("expired or revoked");
  expect(f.first.observe("op")?.state).toBe("stopped");
});

test("a late old process exit cannot revoke the replacement generation", () => {
  const f = fixture(); const old = f.first.claim("op");
  f.advance(20_001); const next = f.second.claim("op");
  f.first.release(old);
  expect(() => f.second.authorize(next)).not.toThrow();
});
