import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { nodeKeyId, type NodeIdentity } from "./node-identity.js";
import { ACCESS_PROTOCOL, accessRevocationTarget, ACCESS_POLICY_TTL_MS, ACCESS_DELEGATION_TTL_MS, signAccessArtifact, validateAccessPolicy, validateAccessGrant, validateAccessDelegation, evaluateAccess,
  type AccessPolicy, type AccessGrant, type AccessDelegation, type AccessPrincipal } from "./mesh-access.js";
import { MeshAccessStore } from "./mesh-access-store.js";
import { evaluateMeshIngress, applyMeshGateMode } from "./mesh-ingress-gate.js";
import { PeerNonceCache, signScopedPeerRequest } from "./mesh-peer-auth.js";

import { accessTestKey, accessTestFixture } from "./test-helpers/access-fixture.test.ts";
const unsigned = <T extends { signature: string }>(value: T): Omit<T, "signature"> => { const { signature: _, ...rest } = value; return rest; };

describe("key-backed scoped access", () => {
  test("service receives only explicit agent union/project scope and never owner's role", () => {
    const f = accessTestFixture();
    const proof = validateAccessDelegation(f.delegation, f.policy, f.audience, f.now);
    const evaluate = (action: any, resource: any, grants = [f.grant]) => evaluateAccess({ policy: f.policy, proof, grants, audience: f.audience, action, resource, now: f.now });
    expect(evaluate("request", { agentId: "fabric" })).toBe(true);
    expect(evaluate("request", { agentId: "secret" })).toBe(false);
    expect(evaluate("admin", { agentId: "fabric" })).toBe(false);
    expect(evaluate("read-history", { agentId: "fabric" })).toBe(false);
    const projectGrant = signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), scope: { all: false, agentIds: ["fabric"], projectIds: ["project.x"] } });
    expect(evaluate("request", { agentId: "future-agent", projectId: "project.x" }, [projectGrant])).toBe(true);
    const empty = signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), scope: { all: false, agentIds: [], projectIds: [] } });
    expect(evaluate("request", { agentId: "fabric" }, [empty])).toBe(false);
  });
  test("expired, forged, cross-network and overlong artifacts fail closed", () => {
    const f = accessTestFixture();
    expect(() => validateAccessPolicy({ ...f.policy, label: "forged" }, f.now)).toThrow();
    expect(() => validateAccessPolicy(f.policy, f.now + ACCESS_POLICY_TTL_MS)).toThrow();
    expect(() => validateAccessDelegation(f.delegation, f.policy, "other", f.now)).toThrow();
    expect(() => validateAccessDelegation(signAccessArtifact(f.service, { ...unsigned(f.delegation), expiresAt: f.now + ACCESS_DELEGATION_TTL_MS + 1 }), f.policy, f.audience, f.now)).toThrow();
    const foreign = accessTestFixture();
    expect(() => validateAccessDelegation(f.delegation, foreign.policy, f.audience, f.now)).toThrow();
    const forged = signAccessArtifact<AccessGrant>(f.service, { ...unsigned(f.grant), issuerId: f.subject.id });
    expect(() => validateAccessGrant(forged, f.policy, f.now)).toThrow();
  });
  test("admin may issue resource grants but cannot elevate or survive removed authority", () => {
    const f = accessTestFixture();
    const grant = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), issuerId: f.adminPrincipal.id });
    expect(() => validateAccessGrant(grant, f.policy, f.now)).not.toThrow();
    const elevated = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(grant), actions: ["admin"] });
    expect(() => validateAccessGrant(elevated, f.policy, f.now)).toThrow();
    const policy = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, members: f.policy.members.filter((m) => m.principal.id !== f.adminPrincipal.id) });
    expect(() => validateAccessGrant(grant, policy, f.now)).toThrow();
  });
  test("owner on two approved devices still intersects each device's capabilities", () => {
    const f = accessTestFixture();
    for (const device of [f.device, accessTestKey()]) {
      const delegation = signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(f.delegation), principalId: f.policy.root.id, devicePublicKey: device.publicKey, actions: ["discover"] });
      const proof = validateAccessDelegation(delegation, f.policy, f.audience, f.now);
      expect(evaluateAccess({ policy: f.policy, proof, grants: [], audience: f.audience, action: "discover", resource: { agentId: "any-enrolled" }, now: f.now })).toBe(true);
      expect(evaluateAccess({ policy: f.policy, proof, grants: [], audience: f.audience, action: "request", resource: { agentId: "any-enrolled" }, now: f.now })).toBe(false);
    }
  });
});

describe("durable receiver policy", () => {
  test("rollback, conflict and revocation resurrection are rejected across store reopen", () => {
    const f = accessTestFixture(), db = new Database(":memory:");
    let store = new MeshAccessStore(db, f.audience);
    store.importPolicy(f.policy, true, f.now); store.importGrant(f.grant, f.now);
    const revoked = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, revokedDeviceIds: [nodeKeyId(f.device.publicKey)] });
    store.acceptDelegation(f.delegation, f.now);
    store.importPolicy(revoked, false, f.now);
    store = new MeshAccessStore(db, f.audience);
    expect(store.knownDevice(nodeKeyId(f.device.publicKey))).toBe(true);
    expect(() => store.verifyDelegation(f.delegation, f.now)).toThrow();
    expect(() => store.importPolicy(f.policy, false, f.now)).toThrow();
    expect(() => store.importPolicy(signAccessArtifact(f.owner, { ...unsigned(f.policy), revision: 3 }), false, f.now)).toThrow();
    const grant = signAccessArtifact<AccessGrant>(f.owner, { ...unsigned(f.grant), revision: 2, revoked: true });
    store.importGrant(grant, f.now);
    expect(() => store.importGrant(signAccessArtifact(f.owner, { ...unsigned(f.grant), revision: 3 }), f.now)).toThrow();
    db.close();
  });
  test("policy import grants no resource authority; local deny immediately wins", () => {
    const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
    store.importPolicy(f.policy, true, f.now); store.importGrant(f.grant, f.now);
    const proof = store.verifyDelegation(f.delegation, f.now);
    expect(store.resource(f.policy.networkId, "fabric")).toBeUndefined();
    store.enroll({ networkId: f.policy.networkId, agentIds: ["fabric"], projects: [] }, new Set(), new Set(["fabric"]));
    const resource = store.resource(f.policy.networkId, "fabric")!;
    expect(store.allowed(proof, "request", resource, f.now)).toBe(true);
    store.revoke(f.policy.networkId, "grant", accessRevocationTarget(f.grant.issuerId, f.grant.id), f.now);
    expect(store.allowed(proof, "request", resource, f.now)).toBe(false);
    db.close();
  });
});

test("mandatory scoped ingress cannot fall through loopback, warn mode, proxy or upgrades", () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true, f.now);
  const body = JSON.stringify({ operation: "discover", delegation: f.delegation });
  const headers = signScopedPeerRequest(f.device, { delegation: f.delegation, method: "POST", path: "/v1/access/rpc", body, destinationKeyId: f.audience, ts: f.now });
  const input = { transport: "loopback" as const, method: "POST", pathname: "/v1/access/rpc", requestTarget: "/v1/access/rpc", body,
    headers: { peer: headers["x-openscout-peer"], ts: headers["x-openscout-ts"], nonce: headers["x-openscout-nonce"], signature: headers["x-openscout-signature"] },
    destinationKeyId: f.audience, bootedAt: f.now - 1000, now: f.now, lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(),
    scopedAccess: { accept: (proof: import("./mesh-access.js").AccessProof) => store.acceptDelegation(proof.delegation, f.now), knownDevice: (id: string) => store.knownDevice(id), verify: (body: any) => store.verifyDelegation(body.delegation, f.now) } };
  expect(evaluateMeshIngress(input).action).toBe("allow");
  expect(evaluateMeshIngress(input).action).toBe("deny");
  for (const pathname of ["/v1/mesh/web-request", "/trpc", "/v1/snapshot", "/v1/node", "/v1/guest/agents", "/v1/access/admin"]) {
    const decision = evaluateMeshIngress({ ...input, pathname, requestTarget: pathname });
    expect(decision.action).toBe("deny");
    expect(applyMeshGateMode(decision, { mode: "verify-warn", method: "POST", pathname, logger: { warn() {} } }).action).toBe("deny");
  }
  db.close();
});

test("principal revocation invalidates its issued grants and cannot be cleared by later policy", () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true, f.now);
  const adminGrant = signAccessArtifact<AccessGrant>(f.admin, { ...unsigned(f.grant), issuerId: f.adminPrincipal.id });
  store.importGrant(adminGrant, f.now);
  store.enroll({ networkId: f.policy.networkId, agentIds: ["fabric"], projects: [] }, new Set(), new Set(["fabric"]));
  const proof = store.verifyDelegation(f.delegation, f.now), resource = store.resource(f.policy.networkId, "fabric")!;
  expect(store.allowed(proof, "request", resource, f.now)).toBe(true);
  const revoked = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, revokedPrincipalIds: [f.adminPrincipal.id] });
  store.importPolicy(revoked, false, f.now);
  expect(store.allowed(proof, "request", resource, f.now)).toBe(false);
  expect(() => store.importPolicy(signAccessArtifact(f.owner, { ...unsigned(f.policy), revision: 3 }), false, f.now)).toThrow();
  db.close();
});

test("project enrollment resolves current canonical roots and fails closed on rename/symlink ambiguity", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "scoped-project-test-"))), root = join(base, "project"), moved = join(base, "moved");
  mkdirSync(root);
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  try {
    store.importPolicy(f.policy, true, f.now);
    const enrollment = store.enroll({ networkId: f.policy.networkId, agentIds: [], projects: [{ id: "", root }] }, new Set([root]), new Set());
    const projectId = enrollment.projects[0]!.id;
    expect(store.resource(f.policy.networkId, "new-agent", root)).toEqual({ agentId: "new-agent", projectId });
    expect(store.resource(f.policy.networkId, "new-agent", join(root, ".."))).toBeUndefined();
    const link = join(base, "alias"); symlinkSync(root, link);
    expect(() => store.enroll({ networkId: f.policy.networkId, agentIds: [], projects: [{ id: "", root: link }] }, new Set([root]), new Set())).toThrow();
    expect(store.resource(f.policy.networkId, "new-agent", link)).toBeUndefined();
    renameSync(root, moved);
    expect(store.resource(f.policy.networkId, "new-agent", root)).toBeUndefined();
    expect(store.resource(f.policy.networkId, "new-agent", moved)).toBeUndefined();
  } finally { db.close(); rmSync(base, { recursive: true, force: true }); }
});

test("scoped routes are isolated from legacy handlers and loopback HTTP deputies", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const routes = readFileSync(join(import.meta.dir, "broker-access-http-routes.ts"), "utf8");
  for (const forbidden of ["requestForHost", "fetch(", "forwardPeer", "meshHttpService", "wakeMeshHarnessSession", "startMeshProjectSession"]) expect(routes).not.toContain(forbidden);
  for (const service of ["deps.postMessage(", "deps.invoke(", "deps.openThread(", "store.allowed("]) expect(routes).toContain(service);
});

test("a service credential cannot also act as an owner device, and delegation IDs are immutable", () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true, f.now);
  store.acceptDelegation(f.delegation, f.now);
  const ownerDevice = signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(f.delegation), id: "owner-delegation", principalId: f.policy.root.id });
  expect(() => store.verifyDelegation(ownerDevice, f.now)).toThrow("each device credential belongs to one principal");
  const changed = signAccessArtifact<AccessDelegation>(f.service, { ...unsigned(f.delegation), actions: ["discover"] });
  expect(() => store.verifyDelegation(changed, f.now)).toThrow("delegation IDs are immutable");
  db.close();
});
