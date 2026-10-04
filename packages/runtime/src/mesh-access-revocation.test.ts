import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeKeyId, type NodeIdentity } from "./node-identity.js";
import { ACCESS_PROTOCOL, ACCESS_ARTIFACT_MAX_BYTES, ACCESS_CLOCK_SKEW_MS, accessRevocationTarget, accessRequestHash, validateAccessDelegation, validateAccessGrant, signAccessArtifact, validateAccessRevocation,
  type AccessPolicy, type AccessGrant, type AccessDelegation, type AccessRevocation } from "./mesh-access.js";
import { MeshAccessStore, ACCESS_AUDIT_MAX_ROWS, ACCESS_ADMIN_AUDIT_MAX_ROWS, ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER } from "./mesh-access-store.js";
import { accessTestFixture, accessTestKey } from "./test-helpers/access-fixture.test.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const unsigned = <T extends { signature: string }>(value: T): Omit<T, "signature"> => { const { signature: _, ...rest } = value; return rest; };
function setup() {
  const f = accessTestFixture(), db = new Database(":memory:"); databases.push(db);
  const store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true, f.now); store.importGrant(f.grant, f.now);
  const proof = store.acceptDelegation(f.delegation, f.now);
  const revoke = (key: NodeIdentity, targetKind: AccessRevocation["targetKind"], targetId: string, networkId = f.policy.networkId) =>
    signAccessArtifact<AccessRevocation>(key, { protocol: ACCESS_PROTOCOL, kind: "revocation", networkId, issuerId: nodeKeyId(key.publicKey),
      issuerPublicKey: key.publicKey, targetKind, targetId, issuedAt: f.now });
  return { ...f, db, store, proof, revoke };
}

describe("signed negative-only revocations", () => {
  test("grant issuer revokes its own grant durably and all later revisions remain denied", () => {
    const f = setup();
    const revocation = f.revoke(f.owner, "grant", f.grant.id);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(true);
    f.store.submitArtifact(revocation, f.now);
    const reopened = new MeshAccessStore(f.db, f.audience);
    expect(reopened.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(false);
    expect(() => reopened.importRevocation(revocation, f.now)).not.toThrow();
    expect(() => reopened.importGrant(signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), revision: 2 }), f.now)).toThrow("revoked grants");
    expect(reopened.status().signedRevocations[0]).toEqual({ artifact: revocation, targetExpiresAt: f.grant.expiresAt });
  });
  test("admin issuer can withdraw a grant after root removes that admin and policy expires", () => {
    const f = setup();
    const grant = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), id: "admin-grant", issuerId: f.adminPrincipal.id });
    f.store.importGrant(grant, f.now);
    f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2,
      members: f.policy.members.filter((m) => m.principal.id !== f.adminPrincipal.id) }), false, f.now);
    expect(() => new MeshAccessStore(f.db, f.audience).importRevocation(f.revoke(f.admin, "grant", grant.id), f.policy.expiresAt + 1)).not.toThrow();
  });
  test("principal revokes its device permanently, blocking newly signed delegation IDs", () => {
    const f = setup(), deviceId = nodeKeyId(f.device.publicKey);
    f.store.importRevocation(f.revoke(f.service, "device", deviceId), f.now);
    const reopened = new MeshAccessStore(f.db, f.audience);
    expect(() => reopened.verifyDelegation(f.delegation, f.now)).toThrow("access denied");
    expect(() => reopened.verifyDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), id: "renewed" }), f.now)).toThrow("access denied");
    expect(reopened.status().signedRevocations[0]!.targetExpiresAt).toBeNull();
    expect(reopened.knownDevice(deviceId)).toBe(true);
  });
  test("principal revokes one delegation without revoking a distinct delegation on the same device", () => {
    const f = setup();
    f.store.importRevocation(f.revoke(f.service, "delegation", f.delegation.id), f.now);
    expect(() => f.store.verifyDelegation(f.delegation, f.now)).toThrow();
    expect(() => f.store.verifyDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), id: "distinct" }), f.now)).not.toThrow();
    expect(f.store.status().signedRevocations[0]!.targetExpiresAt).toBe(f.delegation.expiresAt);
  });
  test("owner and admin withdrawals are confined to their own device/delegation namespace and issued grants", () => {
    const f = setup();
    const grant = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), id: "admin-grant", issuerId: f.adminPrincipal.id });
    f.store.importGrant(grant, f.now);
    for (const key of [f.owner, f.admin, f.member]) {
      expect(() => f.store.importRevocation(f.revoke(key, "device", nodeKeyId(f.device.publicKey)), f.now)).not.toThrow();
      expect(() => f.store.importRevocation(f.revoke(key, "delegation", f.delegation.id), f.now)).not.toThrow();
    }
    expect(() => f.store.importRevocation(f.revoke(f.owner, "grant", grant.id), f.now)).toThrow("own known");
    expect(() => f.store.importRevocation(f.revoke(f.service, "grant", f.grant.id), f.now)).toThrow("own known");
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(true);
  });
  test("unknown signer, unknown grant and cross-network grant target are rejected", () => {
    const f = setup(), stranger = accessTestKey(), foreign = accessTestFixture(f.audience, f.now);
    expect(() => f.store.importRevocation(f.revoke(stranger, "grant", f.grant.id), f.now)).toThrow("known network principal");
    expect(() => f.store.importRevocation(f.revoke(f.owner, "grant", "future-id"), f.now)).toThrow("own known");
    f.store.importPolicy(foreign.policy, true, f.now);
    expect(() => f.store.importRevocation(f.revoke(foreign.owner, "grant", f.grant.id, foreign.policy.networkId), f.now)).toThrow("own known");
  });
  test("signatures bind protocol, kind, network, issuer, target and issue time", () => {
    const f = setup(), good = f.revoke(f.owner, "grant", f.grant.id);
    expect(() => validateAccessRevocation(good, f.now)).not.toThrow();
    for (const patch of [{ protocol: "scout-access/2" }, { kind: "grant" }, { networkId: "other-network" },
      { issuerId: f.subject.id }, { issuerPublicKey: f.service.publicKey }, { targetKind: "device" },
      { targetId: "other-grant" }, { issuedAt: f.now - 1 }, { extra: true }])
      expect(() => f.store.importRevocation({ ...good, ...patch } as AccessRevocation, f.now)).toThrow();
    for (const other of [f.policy, f.grant, f.delegation])
      expect(() => f.store.importRevocation({ ...good, signature: other.signature }, f.now)).toThrow();
    expect(() => validateAccessRevocation(signAccessArtifact<AccessRevocation>(f.owner, { ...unsigned(good), issuedAt: f.now + ACCESS_CLOCK_SKEW_MS + 1 }), f.now)).toThrow();
  });
  test("delegation short IDs are scoped to their principal and revocation cannot cross that namespace", () => {
    const f = setup();
    const conflicting = signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(f.delegation), principalId: f.policy.root.id,
      devicePublicKey: accessTestKey().publicKey });
    f.store.acceptDelegation(conflicting, f.now);
    f.store.importRevocation(f.revoke(f.owner, "delegation", f.delegation.id), f.now);
    expect(() => f.store.verifyDelegation(conflicting, f.now)).toThrow();
    expect(() => f.store.verifyDelegation(f.delegation, f.now)).not.toThrow();
  });
});

describe("self-authenticating delivery and policy freshness", () => {
  test("carrier may advance installed policy but cannot add trust or roll back policy and grant revisions", () => {
    const f = setup();
    expect(() => f.store.submitArtifact(accessTestFixture(f.audience, f.now).policy, f.now)).toThrow("local operator");
    const newer = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, issuedAt: f.now });
    f.store.submitArtifact(newer, f.now);
    expect(() => f.store.submitArtifact(f.policy, f.now)).toThrow("revision");
    expect(() => f.store.submitArtifact(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(newer), label: "conflict" }), f.now)).toThrow("revision");
    expect(() => f.store.submitArtifact(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 3 }), f.now)).toThrow("revision");
    f.store.submitArtifact(signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), revision: 2 }), f.now);
    expect(() => f.store.submitArtifact(f.grant, f.now)).toThrow("conflicts");
    expect(() => f.store.submitArtifact({ ...newer, label: "a".repeat(ACCESS_ARTIFACT_MAX_BYTES) }, f.now)).toThrow("size limit");
  });
  test("presenting an identical manifest does not update receipt time, root issue time or expiry", () => {
    const f = setup();
    f.store.submitArtifact(f.policy, f.now + 1000);
    expect(f.store.status().policyFreshness).toEqual([{ networkId: f.policy.networkId, lastReceivedAt: f.now,
      lastRootIssuedAt: f.policy.issuedAt, expiresAt: f.policy.expiresAt }]);
    expect(() => f.store.submitArtifact(f.policy, f.policy.expiresAt)).toThrow("expired");
  });
  test("current root revocation invalidates an admin's grants and cannot be cleared", () => {
    const f = setup();
    f.store.importGrant(signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), id: "admin-grant", issuerId: f.adminPrincipal.id }), f.now);
    f.store.importRevocation(f.revoke(f.owner, "grant", f.grant.id), f.now);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(true);
    const policy = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, revokedPrincipalIds: [f.adminPrincipal.id] });
    f.store.submitArtifact(policy, f.now);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(false);
    expect(() => f.store.submitArtifact(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 3 }), f.now)).toThrow("tombstones");
  });
  test("principal keys cannot also be receiving node or previously classified device keys", () => {
    const f = setup();
    for (const key of [f.owner, f.service])
      expect(() => new MeshAccessStore(f.db, nodeKeyId(key.publicKey)).importPolicy(f.policy, false, f.now)).toThrow("separate");
    const devicePrincipal = { id: nodeKeyId(f.device.publicKey), publicKey: f.device.publicKey, kind: "person" as const, label: "Device as principal" };
    expect(() => f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2,
      members: [...f.policy.members, { principal: devicePrincipal, role: "member" }] }), false, f.now)).toThrow("separate");
  });
  test("same agent or project cannot enroll in two networks, and cross-form overlap fails closed", () => {
    const f = setup(), foreign = accessTestFixture(f.audience, f.now);
    f.store.importPolicy(foreign.policy, true, f.now);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "access-enrollment-")));
    try {
      f.store.enroll({ networkId: f.policy.networkId, agentIds: ["fabric"], projects: [] }, new Set([root]), new Set(["fabric"]));
      expect(() => f.store.enroll({ networkId: foreign.policy.networkId, agentIds: ["fabric"], projects: [] }, new Set([root]), new Set(["fabric"]))).toThrow("one network");
      f.store.enroll({ networkId: foreign.policy.networkId, agentIds: [], projects: [{ id: "", root }] }, new Set([root]), new Set());
      expect(() => f.store.enroll({ networkId: f.policy.networkId, agentIds: [], projects: [{ id: "", root }] }, new Set([root]), new Set())).toThrow("one network");
      expect(f.store.resource(f.policy.networkId, "fabric", root)).toBeUndefined();
      expect(f.store.resource(foreign.policy.networkId, "fabric", root)).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("post-signature persistence and bounded evaluation", () => {
  test("pure validation and local certificate import do not classify keys; self-revocation prevents first use", () => {
    const f = setup(), device = accessTestKey(), id = nodeKeyId(device.publicKey);
    const delegation = signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), id: "import-only", devicePublicKey: device.publicKey });
    const before = f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n;
    f.store.verifyDelegation(delegation, f.now);
    expect(f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n).toBe(before);
    expect(f.store.knownDevice(id)).toBe(false);
    f.store.importDelegation(delegation, f.now);
    expect(f.store.knownDevice(id)).toBe(false);
    expect(() => f.store.importRevocation(f.revoke(f.service, "device", id), f.now)).not.toThrow();
    expect(() => f.store.acceptDelegation(delegation, f.now)).toThrow("access denied");
    expect(f.store.knownDevice(id)).toBe(false);
  });
  test("200-agent discovery with 20 grants and 200 members has no per-check SQL or writes", () => {
    const f = setup();
    const members = [...f.policy.members];
    while (members.length < 200) {
      const key = accessTestKey();
      members.push({ principal: { id: nodeKeyId(key.publicKey), publicKey: key.publicKey, label: "Member", kind: "person" }, role: "member" });
    }
    f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, members }), false, f.now);
    for (let i = 0; i < 19; i++) f.store.importGrant(signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), id: `grant-${i + 2}`,
      scope: { all: true, agentIds: [], projectIds: [] } }), f.now);
    const before = f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n;
    const start = performance.now();
    const prepared = f.store.prepareAccess(f.proof, f.now);
    const queries = spyOn(f.db, "query");
    let allowed = 0;
    try {
      for (let i = 0; i < 200; i++) for (const action of ["discover", "message", "request", "read-own"] as const)
        if (prepared.allowed(action, { agentId: `agent-${i}` })) allowed++;
      expect(queries).toHaveBeenCalledTimes(0);
    } finally { queries.mockRestore(); }
    expect(allowed).toBe(800);
    expect(performance.now() - start).toBeLessThan(500);
    expect(f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n).toBe(before);
  });
  test("request snapshots immediately observe revocation and local undo never clears a signed withdrawal", () => {
    const f = setup(), prepared = f.store.prepareAccess(f.proof, f.now), target = accessRevocationTarget(f.grant.issuerId, f.grant.id);
    expect(prepared.allowed("request", { agentId: "fabric" })).toBe(true);
    f.store.revoke(f.policy.networkId, "grant", target, f.now);
    expect(prepared.allowed("request", { agentId: "fabric" })).toBe(false);
    f.store.unrevoke(f.policy.networkId, "grant", target, f.now);
    expect(prepared.allowed("request", { agentId: "fabric" })).toBe(true);
    f.store.importRevocation(f.revoke(f.owner, "grant", f.grant.id), f.now);
    f.store.unrevoke(f.policy.networkId, "grant", target, f.now);
    expect(prepared.allowed("request", { agentId: "fabric" })).toBe(false);
  });
  test("request snapshots recheck signed expiry when time advances across an await", () => {
    const f = setup(), clock = spyOn(Date, "now").mockReturnValue(f.now);
    try {
      const prepared = f.store.prepareAccess(f.proof);
      expect(prepared.allowed("request", { agentId: "fabric" })).toBe(true);
      clock.mockReturnValue(f.delegation.expiresAt);
      expect(prepared.allowed("request", { agentId: "fabric" })).toBe(false);
    } finally { clock.mockRestore(); }
  });
  test("unauthenticated denials never write and verified audit rows remain within the 10000 row bound", () => {
    const f = setup(), before = f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit").get()!.n;
    const adminBefore = f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE retention_class='administration'").get()!.n;
    for (let i = 0; i < 1000; i++) f.store.auditDenied("forged-key", "rpc", "/v1/access/rpc");
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit").get()!.n).toBe(before);
    for (let i = 0; i < ACCESS_AUDIT_MAX_ROWS + 30; i++) f.store.audit(f.proof, "discover", "inventory", "allow", 1, f.now + i);
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE retention_class='decision'").get()!.n).toBe(ACCESS_AUDIT_MAX_ROWS);
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE retention_class='administration'").get()!.n).toBe(adminBefore);
  });
});

describe("artifact namespace, expiry and resource identity", () => {
  test("two issuers can share a grant short ID and withdraw only their own grant", () => {
    const f = setup(), other = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), issuerId: f.adminPrincipal.id });
    f.store.importGrant(other, f.now);
    expect(f.store.grants(f.policy.networkId)).toHaveLength(2);
    f.store.importRevocation(f.revoke(f.admin, "grant", other.id), f.now);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(true);
    f.store.importRevocation(f.revoke(f.owner, "grant", f.grant.id), f.now);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(false);
  });
  test("root tombstones use issuer/principal namespace and cannot accidentally revoke matching short IDs", () => {
    const f = setup();
    expect(() => f.store.revoke(f.policy.networkId, "grant", f.grant.id, f.now)).toThrow("namespace");
    f.store.importGrant(signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), issuerId: f.adminPrincipal.id }), f.now);
    f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2,
      revokedGrantIds: [accessRevocationTarget(f.grant.issuerId, f.grant.id)] }), false, f.now);
    expect(f.store.allowed(f.proof, "request", { agentId: "fabric" }, f.now)).toBe(true);
    expect(() => f.store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 3,
      revokedGrantIds: ["bare-id"] }), false, f.now)).toThrow("namespace");
  });
  test("expired grant and delegation tombstones prevent later renewal and survive reopening", () => {
    const f = setup();
    f.store.importRevocation(f.revoke(f.owner, "grant", f.grant.id), f.now);
    f.store.importRevocation(f.revoke(f.service, "delegation", f.delegation.id), f.now);
    const now = f.policy.expiresAt + 1000, store = new MeshAccessStore(f.db, f.audience);
    store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, issuedAt: now, expiresAt: now + 60_000 }), false, now);
    expect(() => store.importGrant(signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), revision: 2, issuedAt: now, expiresAt: now + 50_000 }), now)).toThrow("revoked");
    expect(() => store.verifyDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), issuedAt: now, expiresAt: now + 40_000 }), now)).toThrow();
    expect(store.status().signedRevocations).toHaveLength(2);
  });
  test("15 second issue-time skew is accepted but signed expiry is never extended", () => {
    const f = setup();
    for (const ahead of [1000, ACCESS_CLOCK_SKEW_MS]) {
      expect(() => validateAccessGrant(signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), issuedAt: f.now + ahead }), f.policy, f.now)).not.toThrow();
      expect(() => validateAccessDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), issuedAt: f.now + ahead }), f.policy, f.audience, f.now)).not.toThrow();
    }
    expect(() => validateAccessDelegation(signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), issuedAt: f.now + ACCESS_CLOCK_SKEW_MS + 1 }), f.policy, f.audience, f.now)).toThrow();
    expect(() => validateAccessDelegation(f.delegation, f.policy, f.audience, f.delegation.expiresAt)).toThrow();
  });
  test("replacement directory at identical path does not inherit project authority", () => {
    const f = setup(), base = realpathSync(mkdtempSync(join(tmpdir(), "access-inode-"))), root = join(base, "project");
    mkdirSync(root);
    try {
      const project = f.store.enroll({ networkId: f.policy.networkId, agentIds: [], projects: [{ id: "", root }] }, new Set([root]), new Set()).projects[0]!;
      expect(project.id).toMatch(/^project\.[a-f0-9-]{36}$/);
      expect(f.store.resource(f.policy.networkId, "agent", root)?.projectId).toBe(project.id);
      renameSync(root, join(base, "old-project")); mkdirSync(root);
      expect(f.store.resource(f.policy.networkId, "agent", root)).toBeUndefined();
      const replacement = f.store.enroll({ networkId: f.policy.networkId, agentIds: [], projects: [{ id: "", root }] }, new Set([root]), new Set()).projects[0]!;
      expect(replacement.id).not.toBe(project.id);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test("legacy grant keys and work payload rows migrate to namespaced keys and payload hashes", () => {
    const f = accessTestFixture(), db = new Database(":memory:"); databases.push(db);
    db.exec("CREATE TABLE mesh_access_grants(id TEXT PRIMARY KEY,network_id TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE mesh_access_work(id TEXT PRIMARY KEY,network_id TEXT NOT NULL,principal_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT,request_json TEXT NOT NULL)");
    db.query("INSERT INTO mesh_access_grants VALUES(?1,?2,?3)").run(f.grant.id, f.policy.networkId, JSON.stringify(f.grant));
    const payload = { message: "sensitive original body", target: "fabric" };
    db.query("INSERT INTO mesh_access_work VALUES('work',?1,?2,'fabric',NULL,?3)").run(f.policy.networkId, f.subject.id, JSON.stringify(payload));
    const store = new MeshAccessStore(db, f.audience);
    store.importPolicy(f.policy, true, f.now);
    store.importGrant(signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), issuerId: f.adminPrincipal.id }), f.now);
    expect(store.grants(f.policy.networkId)).toHaveLength(2);
    expect(store.work("work")!.request_hash).toBe(accessRequestHash(payload));
    expect(JSON.stringify(db.query("SELECT * FROM mesh_access_work").all())).not.toContain(payload.message);
    const proof = store.acceptDelegation(f.delegation, f.now);
    store.recordWork("new-work", proof, { agentId: "fabric" }, payload);
    expect(store.work("new-work")!.request_hash).toBe(accessRequestHash(payload));
    expect(db.query<{ name: string }>("PRAGMA table_info(mesh_access_work)").all().some((c) => c.name === "request_json")).toBe(false);
    expect(new MeshAccessStore(db, f.audience).grants(f.policy.networkId)).toHaveLength(2);
  });
});

test("legacy bare grant or delegation denials disable scoped access until explicit offline migration", () => {
  for (const kind of ["grant", "delegation"]) {
    const f = accessTestFixture(), db = new Database(":memory:"); databases.push(db);
    db.exec("CREATE TABLE mesh_access_denials(network_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(network_id,kind,id))");
    db.query("INSERT INTO mesh_access_denials VALUES(?1,?2,'legacy-id',?3)").run(f.policy.networkId, kind, f.now);
    const store = new MeshAccessStore(db, f.audience);
    expect(store.healthy()).toBe(false);
    expect(() => store.importPolicy(f.policy, true, f.now)).toThrow("offline namespace migration");
    expect(() => store.status()).toThrow("offline namespace migration");
    expect(db.query<{ id: string }>("SELECT id FROM mesh_access_denials").get()!.id).toBe("legacy-id");
    // Explicit offline migration supplies the responsible issuer/principal, never guessed by startup.
    db.query("UPDATE mesh_access_denials SET id=?1").run(accessRevocationTarget(f.policy.root.id, "legacy-id"));
    expect(new MeshAccessStore(db, f.audience).healthy()).toBe(true);
  }
});

describe("pre-positioned self-revocation and replay-resistant audit", () => {
  test("unseen delegation and device withdrawals block first use only for their signing principal", () => {
    const f = setup(), device = accessTestKey();
    const delegation = signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), id: "never-seen", devicePublicKey: device.publicKey });
    f.store.importRevocation(f.revoke(f.service, "delegation", delegation.id), f.now);
    expect(() => f.store.acceptDelegation(delegation, f.now)).toThrow("access denied");
    f.store.importRevocation(f.revoke(f.service, "device", nodeKeyId(device.publicKey)), f.now);
    const renewed = signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(delegation), id: "fresh-delegation" });
    expect(() => f.store.acceptDelegation(renewed, f.now)).toThrow("access denied");
    expect(f.store.knownDevice(nodeKeyId(device.publicKey))).toBe(false);
    const ownerDelegation = signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(delegation), principalId: f.policy.root.id });
    expect(() => f.store.acceptDelegation(ownerDelegation, f.now)).not.toThrow();
    expect(f.store.allowed(f.store.verifyDelegation(ownerDelegation, f.now), "request", { agentId: "fabric" }, f.now)).toBe(true);
    const reopened = new MeshAccessStore(f.db, f.audience);
    expect(() => reopened.verifyDelegation(renewed, f.now)).toThrow("access denied");
    expect(() => reopened.verifyDelegation(ownerDelegation, f.now)).not.toThrow();
  });
  test("unknown-target tombstones are capped separately per issuer and target kind", () => {
    const f = setup();
    for (const kind of ["delegation", "device"] as const) {
      for (let i = 0; i < ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER; i++) {
        const id = kind === "device" ? i.toString(16).padStart(64, "0") : `unseen-${i}`;
        f.store.importRevocation(f.revoke(f.service, kind, id), f.now);
      }
      const extraId = kind === "device" ? "f".repeat(64) : "overflow";
      expect(() => f.store.importRevocation(f.revoke(f.service, kind, extraId), f.now)).toThrow("limit reached");
      // Another principal has a separate budget and can only revoke its own namespace.
      expect(() => f.store.importRevocation(f.revoke(f.owner, kind, extraId), f.now)).not.toThrow();
      const firstId = kind === "device" ? "0".repeat(64) : "unseen-0";
      expect(() => f.store.importRevocation(f.revoke(f.service, kind, firstId), f.now)).not.toThrow();
    }
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_revocations WHERE unknown_target=1").get()!.n)
      .toBe(2 * ACCESS_UNKNOWN_REVOCATIONS_PER_ISSUER + 2);
    expect(() => f.store.importRevocation(f.revoke(f.service, "device", "not-a-key-id"), f.now)).toThrow("canonical key ID");
  });
  test("legacy signed device tombstones migrate using their signed issuer and remain effective", () => {
    const f = setup(), artifact = f.revoke(f.service, "device", nodeKeyId(f.device.publicKey));
    f.store.importRevocation(artifact, f.now);
    f.db.query("UPDATE mesh_access_revocations SET id=?1 WHERE kind='device'").run(artifact.targetId);
    const reopened = new MeshAccessStore(f.db, f.audience);
    expect(reopened.healthy()).toBe(true);
    expect(f.db.query<{ id: string }>("SELECT id FROM mesh_access_revocations WHERE kind='device'").get()!.id)
      .toBe(accessRevocationTarget(artifact.issuerId, artifact.targetId));
    expect(() => reopened.verifyDelegation(f.delegation, f.now)).toThrow("access denied");
    expect(new MeshAccessStore(f.db, f.audience).healthy()).toBe(true);
    f.db.query("UPDATE mesh_access_revocations SET json=?1 WHERE kind='device'").run(JSON.stringify({ ...artifact, issuerId: f.policy.root.id }));
    expect(new MeshAccessStore(f.db, f.audience).healthy()).toBe(false);
  });
  test("identical canonical artifact imports do not write, change freshness, invalidate snapshots or evict decisions", () => {
    const f = setup(), revocation = f.revoke(f.service, "delegation", "unused-delegation");
    f.store.importRevocation(revocation, f.now);
    f.store.audit(f.proof, "request", "retained-decision", "allow", 1, f.now);
    const prepared = f.store.prepareAccess(f.proof, f.now);
    const before = f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n;
    const verify = spyOn(f.store, "verifyDelegation");
    const reorderedPolicy = Object.fromEntries(Object.entries(f.policy).reverse()) as AccessPolicy;
    try {
      for (let i = 0; i < 10_005; i++) f.store.submitArtifact(reorderedPolicy, f.now + 1000);
      f.store.submitArtifact(f.grant, f.now + 1000);
      f.store.submitArtifact(revocation, f.now + 1000);
      const renewedRevocation = signAccessArtifact<AccessRevocation>(f.service, { ...unsigned(revocation), issuedAt: f.now + 1000 });
      f.store.submitArtifact(renewedRevocation, f.now + 1000);
      expect(prepared.allowed("request", { agentId: "fabric" })).toBe(true);
      expect(verify).toHaveBeenCalledTimes(0);
    } finally { verify.mockRestore(); }
    expect(f.db.query<{ n: number }>("SELECT total_changes() AS n").get()!.n).toBe(before);
    expect(f.store.status().policyFreshness[0]!.lastReceivedAt).toBe(f.now);
    expect(f.db.query("SELECT id FROM mesh_access_audit WHERE resource='retained-decision'").get()).not.toBeNull();
    const newer = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, issuedAt: f.now + 1000 });
    f.store.submitArtifact(newer, f.now + 1000);
    expect(f.store.status().policyFreshness[0]!.lastReceivedAt).toBe(f.now + 1000);
  });
  test("administration/import and decision audit retention cannot evict each other", () => {
    const f = setup();
    f.store.audit(f.proof, "request", "protected-decision", "allow", 1, f.now);
    for (let i = 0; i < ACCESS_ADMIN_AUDIT_MAX_ROWS + 10; i++)
      f.store.audit(undefined, "revocation.import", `admin-${i}`, "allow", 1, f.now);
    expect(f.db.query("SELECT id FROM mesh_access_audit WHERE resource='protected-decision'").get()).not.toBeNull();
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE retention_class='administration'").get()!.n).toBe(ACCESS_ADMIN_AUDIT_MAX_ROWS);
    f.store.audit(undefined, "policy.import", "protected-admin", "allow", 2, f.now);
    for (let i = 0; i < ACCESS_AUDIT_MAX_ROWS + 10; i++) f.store.audit(f.proof, "discover", "inventory", "allow", 2, f.now);
    expect(f.db.query("SELECT id FROM mesh_access_audit WHERE resource='protected-admin'").get()).not.toBeNull();
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit WHERE retention_class='decision'").get()!.n).toBe(ACCESS_AUDIT_MAX_ROWS);
    expect(f.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM mesh_access_audit").get()!.n).toBe(ACCESS_AUDIT_MAX_ROWS + ACCESS_ADMIN_AUDIT_MAX_ROWS);
    expect(f.store.status().auditAdministration.some((row: any) => row.resource === "protected-admin")).toBe(true);
  });
});
