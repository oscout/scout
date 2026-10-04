import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ACCESS_PROTOCOL, signAccessArtifact, type AccessRevocation, type AccessDelegation } from "./mesh-access.js";
import { MeshAccessStore, ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER } from "./mesh-access-store.js";
import { accessTestFixture } from "./test-helpers/access-fixture.test.ts";

test("2000 service unknown-target revocations preserve owner policy and grant administration audit", () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  try {
    store.importPolicy(f.policy, true, f.now);
    store.importGrant(f.grant, f.now);
    const readAdmin = () => db.query("SELECT * FROM mesh_access_audit WHERE retention_class='administration' ORDER BY id").all();
    const ownerAudit = readAdmin();
    expect(ownerAudit).toHaveLength(2);
    expect(ownerAudit.map((row: any) => row.action)).toEqual(["policy.import", "grant.import"]);
    for (const targetKind of ["delegation", "device"] as const) {
      for (let i = 0; i < ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER; i++) {
        const targetId = targetKind === "device" ? i.toString(16).padStart(64, "0") : `unseen-${i}`;
        store.submitArtifact(signAccessArtifact<AccessRevocation>(f.service, { protocol: ACCESS_PROTOCOL, kind: "revocation",
          networkId: f.policy.networkId, issuerId: f.subject.id, issuerPublicKey: f.service.publicKey,
          targetKind, targetId, issuedAt: f.now }), f.now);
      }
    }
    expect(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_revocations WHERE unknown_target=1").get()!.n).toBe(2000);
    expect(readAdmin()).toEqual(ownerAudit);
    expect(new MeshAccessStore(db, f.audience).status().auditAdministration).toEqual([...ownerAudit].reverse());
    // Withdrawal of an installed grant still produces a useful administration event.
    store.submitArtifact(signAccessArtifact<AccessRevocation>(f.owner, { protocol: ACCESS_PROTOCOL, kind: "revocation",
      networkId: f.policy.networkId, issuerId: f.policy.root.id, issuerPublicKey: f.owner.publicKey,
      targetKind: "grant", targetId: f.grant.id, issuedAt: f.now }), f.now);
    expect(readAdmin()).toHaveLength(3);
    expect((readAdmin()[2] as any).action).toBe("revocation.import");
  } finally { db.close(); }
});


test("member cannot use registered-then-withdrawn certificates to evict privileged administration history", () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  try {
    store.importPolicy(f.policy, true, f.now); store.importGrant(f.grant, f.now);
    const { signature, ...unsigned } = f.delegation;
    for (let i = 0; i < 1001; i++) {
      const id = `known-service-${i}`;
      store.importDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned, id }), f.now);
      store.importRevocation(signAccessArtifact<AccessRevocation>(f.service, { protocol: ACCESS_PROTOCOL, kind: "revocation", networkId: f.policy.networkId,
        issuerId: f.subject.id, issuerPublicKey: f.service.publicKey, targetKind: "delegation", targetId: id, issuedAt: f.now }), f.now);
    }
    expect(store.status().auditAdministration.map((r: any) => r.action).sort()).toEqual(["grant.import", "policy.import"]);
    const row = db.query<any>("SELECT * FROM mesh_access_audit WHERE action='revocation.import' LIMIT 1").get();
    expect(row.principal_id).toBe(f.subject.id); expect(row.device_id).toBeNull(); expect(row.retention_class).toBe("decision");
  } finally { db.close(); }
});

test("local admin reads, previews and idempotent imports preserve policy and grant audit history", async () => {
  const { Readable } = await import("node:stream");
  const { handleBrokerAccessRoute } = await import("./broker-access-http-routes.js");
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  const call = async (body: object) => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { transportContext: { transport: "local" } });
    let status = 0;
    const response = { writeHead(code: number) { status = code; }, end() {}, setHeader() {} };
    await handleBrokerAccessRoute(request as any, response as any, new URL("http://test/v1/access/admin"), "POST", {
      access: store, nodeId: "test", nodeKeyId: f.audience, enforced: () => true, listAgents: () => [],
    } as any);
    expect(status).toBe(200);
  };
  try {
    await call({ operation: "policy.import", artifact: f.policy });
    await call({ operation: "grant.import", artifact: f.grant });
    const before = store.status().auditAdministration;
    expect(before.map((row: any) => row.action).sort()).toEqual(["grant.import", "policy.import"]);
    for (let i = 0; i < 1001; i++) {
      await call({ operation: "status" });
      await call({ operation: "preview", delegation: f.delegation });
      await call({ operation: "policy.import", artifact: f.policy });
      await call({ operation: "grant.import", artifact: f.grant });
      await call({ operation: "delegation.import", artifact: f.delegation });
    }
    expect(store.status().auditAdministration).toEqual(before);
    expect(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE action='delegation.import'").get()!.n).toBe(1);
    await call({ operation: "resources.enroll", networkId: f.policy.networkId, agentIds: [], projects: [] });
    await call({ operation: "resources.enroll", networkId: f.policy.networkId, agentIds: [], projects: [] });
    await call({ operation: "revoke", networkId: f.policy.networkId, kind: "principal", id: f.subject.id });
    await call({ operation: "revoke", networkId: f.policy.networkId, kind: "principal", id: f.subject.id });
    await call({ operation: "unrevoke", networkId: f.policy.networkId, kind: "principal", id: f.subject.id });
    await call({ operation: "unrevoke", networkId: f.policy.networkId, kind: "principal", id: f.subject.id });
    expect(store.status().auditAdministration.map((row: any) => row.action).sort()).toEqual(["grant.import", "local-deny.remove", "policy.import", "resources.enroll", "revoke"]);
  } finally { db.close(); }
}, 30_000);
