import { expect, test } from "bun:test";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";
import { Database } from "bun:sqlite";
import { GuestGrantStore } from "./guest-access.js";
import { MeshAccessStore } from "./mesh-access-store.js";
import { signAccessArtifact, type AccessPolicy } from "./mesh-access.js";
import { accessTestFixture } from "./test-helpers/access-fixture.test.ts";

for (const state of ["active", "revoked", "expired"] as const) {
  test(`principal import rejects ${state} guest keys without changing the existing grant`, () => {
    const f = accessTestFixture(), db = new Database(":memory:"), guests = new GuestGrantStore(db);
    const grant = guests.install({ requestId: "guest-key", clientPublicKey: f.service.publicKey, label: "Guest", allowedTargets: ["fabric"], expiresAt: f.now + 10 }, f.now).grant;
    if (state === "revoked") guests.revoke({ grantId: grant.id }, f.now + 1);
    const store = new MeshAccessStore(db, f.audience, id => guests.knownKey(id));
    try {
      const before = db.query("SELECT * FROM guest_grants").all();
      expect(() => store.importPolicy(f.policy, true, state === "expired" ? f.now + 20 : f.now + 2)).toThrow("separate");
      expect(store.policy(f.policy.networkId)).toBeUndefined();
      expect(db.query("SELECT * FROM guest_grants").all()).toEqual(before);
    } finally { db.close(); }
  });
}

test("historical principal keys stay reserved after policy removal, expiry and database reopen", () => {
  const f = accessTestFixture(), db = new Database(":memory:");
  let store = new MeshAccessStore(db, f.audience);
  try {
    store.importPolicy(f.policy, true, f.now);
    const { signature, ...policy } = f.policy;
    store.importPolicy(signAccessArtifact<AccessPolicy>(f.owner, { ...policy, revision: 2, members: [], revokedPrincipalIds: [f.subject.id] }), false, f.now + 1);
    store = new MeshAccessStore(db, f.audience);
    expect(store.knownPrincipal(f.subject.id)).toBe(true);
    const guests = new GuestGrantStore(db, id => store.knownPrincipal(id));
    expect(() => guests.install({ requestId: "reused-principal", clientPublicKey: f.service.publicKey, label: "Guest", allowedTargets: ["fabric"] }, f.now + 100_000)).toThrow("reserved");
    expect(guests.knownKey(f.subject.id)).toBe(false);
  } finally { db.close(); }
});

for (const state of ["active", "revoked", "expired"] as const) {
  test(`principal and ${state} legacy peer keys stay disjoint in durable stores`, async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { SQLiteControlPlaneStore } = await import("./sqlite-store.js");
    const { nodeFingerprint } = await import("./node-identity.js");
    const dir = mkdtempSync(join(tmpdir(), "scout-access-keys-"));
    const peers = new SQLiteControlPlaneStore(join(dir, "state.sqlite"));
    const f = accessTestFixture();
    const store = new MeshAccessStore(peers.writerDb as ControlPlaneSqliteTransactionalDatabase, f.audience, id => peers.knownTrustedPeerKey(id));
    const peer = { keyId: f.subject.id, publicKey: f.service.publicKey, fingerprint: nodeFingerprint(f.service.publicKey), label: "Legacy", tier: "control" as const, grantedVia: "sas" as const, grantedAt: f.now - 1000, ...(state === "revoked" ? { revokedAt: f.now - 1 } : {}), ...(state === "expired" ? { expiresAt: f.now - 1 } : {}) };
    try {
      peers.upsertTrustedPeer(peer);
      expect(() => store.importPolicy(f.policy, true, f.now)).toThrow("separate");
      expect(peers.knownTrustedPeerKey(f.subject.id)).toBe(true);
      const separate = accessTestFixture(f.audience);
      store.importPolicy(separate.policy, true, f.now);
      store.revoke(separate.policy.networkId, "principal", separate.subject.id);
      expect(() => peers.upsertTrustedPeer({ ...peer, keyId: separate.subject.id, publicKey: separate.service.publicKey, fingerprint: nodeFingerprint(separate.service.publicKey) })).toThrow("key_in_use");
      expect(peers.trustedPeer(f.subject.id) !== undefined).toBe(state === "active");
    } finally { peers.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
