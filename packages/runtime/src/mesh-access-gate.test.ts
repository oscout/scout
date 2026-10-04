import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { MeshAccessStore } from "./mesh-access-store.js";
import { createMeshIngressGate } from "./mesh-ingress-gate.js";
import { PeerNonceCache, signScopedPeerRequest } from "./mesh-peer-auth.js";
import { nodeKeyId } from "./node-identity.js";
import { accessTestFixture } from "./test-helpers/access-fixture.test.ts";

test("unverified traffic cannot bind keys or grow durable audit; public carriage and streamed buffers are bounded", async () => {
  const f = accessTestFixture(), db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  store.importPolicy(f.policy, true, f.now);
  let logs = 0, handled = 0;
  const gate = createMeshIngressGate({ localAdminKey: "ab".repeat(32), mode: "verify-warn", destinationKeyId: f.audience,
    bootedAt: f.now - 1000, lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(), logger: { warn() { logs++; } },
    scopedAccess: { knownDevice: (id) => store.knownDevice(id), verify: (body: any) => store.verifyDelegation(body.delegation), accept: (proof) => store.acceptDelegation(proof.delegation) } });
  const server = createServer((req, res) => { void gate.gateHttpRequest(req, res, async () => { handled++; res.writeHead(200); res.end("{}"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const count = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM mesh_access_audit").get()!.n;
  try {
    const before = count(), body = JSON.stringify({ operation: "discover", delegation: f.delegation });
    const signed = signScopedPeerRequest(f.device, { delegation: f.delegation, method: "POST", path: "/v1/access/rpc", body, destinationKeyId: f.audience });
    for (let i = 0; i < 200; i++) {
      const response = await fetch(base + "/v1/access/rpc", { method: "POST", body, headers: { ...signed, "x-openscout-signature": "invalid" } });
      expect(response.status).toBe(401);
    }
    expect(store.knownDevice(nodeKeyId(f.device.publicKey))).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM mesh_access_delegations").get()!.n).toBe(0);
    expect(count()).toBe(before); expect(logs).toBe(1); expect(handled).toBe(0);
    expect((await fetch(base + "/v1/access/rpc", { method: "POST", body, headers: signed })).status).toBe(200);
    expect(store.knownDevice(nodeKeyId(f.device.publicKey))).toBe(true);
    for (let i = 0; i < 100; i++) await fetch(base + "/v1/snapshot", { headers: { "x-openscout-peer": nodeKeyId(f.device.publicKey) } });
    expect(count()).toBe(before + 1); expect(logs).toBe(2); // One verified delegation import, no unauthenticated writes.
    expect((await fetch(base + "/v1/access/rpc", { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await fetch(base + "/v1/access/policy", { method: "POST", body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
    for (let i = 0; i < 19; i++) expect((await fetch(base + "/v1/access/policy", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(base + "/v1/access/policy", { method: "POST", body: "{}" })).status).toBe(429);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test("credential-store failure is a controlled hard denial for peer requests", async () => {
  const gate = createMeshIngressGate({ mode: "verify-warn", localAdminKey: "ab".repeat(32), destinationKeyId: "a".repeat(64),
    bootedAt: Date.now(), lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(), logger: { warn() {} },
    keyConflict: () => { throw new Error("offline migration needed"); } });
  let executed = 0;
  const server = createServer((req, res) => { void gate.gateHttpRequest(req, res, async () => { executed++; res.end("unsafe"); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(base + "/v1/mesh/nodes", { headers: { "x-openscout-peer": "b".repeat(64) } });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "credential_store_unavailable" }); expect(executed).toBe(0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
