import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { LOCAL_ADMIN_HEADER, signLocalAdminRequest, readLocalAdminKey, preserveProtectedIngress } from "./mesh-access-local-auth.js";
import { createMeshIngressGate } from "./mesh-ingress-gate.js";
import { meshRouteMatrixEntries } from "./mesh-route-matrix.js";
import { accessTestKey } from "./test-helpers/access-fixture.test.ts";
import { nodeKeyId } from "./node-identity.js";
import { PeerNonceCache, signPeerRequest } from "./mesh-peer-auth.js";
const secret = "a1".repeat(32);

test("admin key is explicit owner-only material; Unicode and malformed values never throw or authenticate", () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-local-key-")), path = join(dir, "key");
  try {
    writeFileSync(path, secret, { mode: 0o600 }); expect(readLocalAdminKey(path)).toBe(secret);
    expect(readLocalAdminKey(undefined)).toBeUndefined();
    chmodSync(path, 0o644); expect(() => readLocalAdminKey(path)).toThrow(); chmodSync(path, 0o600);
    symlinkSync(path, join(dir, "link")); expect(() => readLocalAdminKey(join(dir, "link"))).toThrow();
    preserveProtectedIngress(dir, secret); expect(() => preserveProtectedIngress(dir, undefined)).toThrow("previously enabled");
    expect(() => preserveProtectedIngress(dir, secret)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("protected gate authenticates TCP, Unix and upgrades even in verify-warn; relay headers cannot restore local trust", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-local-gate-"));
  const peer = accessTestKey();
  const gate = createMeshIngressGate({ mode: "verify-warn", localAdminKey: secret, destinationKeyId: "a".repeat(64), bootedAt: Date.now(), lookupPeer: (id) => id === nodeKeyId(peer.publicKey) ? { publicKey: peer.publicKey, tier: "observe" } : undefined, nonceClaim: new PeerNonceCache(), logger: { warn() {} } });
  let executed = 0;
  const serve = () => createServer((req, res) => { void gate.gateHttpRequest(req, res, async () => { executed++; res.writeHead(200); res.end("operator"); }); });
  const tcp = serve(), unix = serve();
  try {
    tcp.listen(0, "127.0.0.1"); unix.listen(join(dir, "broker.sock"));
    await Promise.all([once(tcp, "listening"), once(unix, "listening")]);
    const base = `http://127.0.0.1:${(tcp.address() as { port: number }).port}`;
    expect((await fetch(base + "/v1/snapshot", { headers: { "x-forwarded-for": "127.0.0.1", "forwarded": "for=127.0.0.1" } })).status).toBe(403);
    expect((await fetch(base + "/v1/snapshot", { headers: signLocalAdminRequest(secret, { method: "GET", path: "/v1/snapshot", destinationKeyId: "a".repeat(64) }) })).status).toBe(200);
    const throughUnix = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = httpRequest({ socketPath: join(dir, "broker.sock"), path: "/v1/snapshot", headers }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end();
    });
    expect(await throughUnix({})).toBe(403); expect(await throughUnix(signLocalAdminRequest(secret, { method: "GET", path: "/v1/snapshot", destinationKeyId: "a".repeat(64) }))).toBe(200);
    let destroyed = false;
    const socket = { remoteAddress: "127.0.0.1", write() {}, destroy() { destroyed = true; } };
    expect(gate.gateUpgrade({ method: "GET", url: "/trpc", headers: {} } as IncomingMessage, socket as any)).toBe(false);
    expect(destroyed).toBe(true);
    expect(gate.gateUpgrade({ method: "GET", url: "/trpc", headers: signLocalAdminRequest(secret, { method: "GET", path: "/trpc", destinationKeyId: "a".repeat(64) }) } as IncomingMessage, socket as any)).toBe(false);
    const captured = signLocalAdminRequest(secret, { method: "GET", path: "/v1/snapshot", destinationKeyId: "a".repeat(64) });
    expect((await fetch(base + "/v1/snapshot", { headers: captured })).status).toBe(200);
    expect((await fetch(base + "/v1/snapshot", { headers: captured })).status).toBe(401);
    const relayedPeer = signPeerRequest(peer, { method: "GET", path: "/v1/mesh/nodes", destinationKeyId: "a".repeat(64) });
    expect((await fetch(base + "/v1/mesh/nodes", { headers: relayedPeer })).status).toBe(200);
    expect((await fetch(base + "/v1/snapshot", { headers: signPeerRequest(peer, { method: "GET", path: "/v1/snapshot", destinationKeyId: "a".repeat(64) }) })).status).toBe(403);
    expect(executed).toBe(4);
  } finally { await Promise.all([new Promise((resolve) => tcp.close(resolve)), new Promise((resolve) => unix.close(resolve))]); rmSync(dir, { recursive: true, force: true }); }
});


test("every matrix non-public route rejects loopback and Unix without operator proof in protected mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scoped-route-matrix-"));
  const gate = createMeshIngressGate({ mode: "verify-warn", localAdminKey: secret, destinationKeyId: "a".repeat(64), bootedAt: Date.now(), lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(), logger: { warn() {} } });
  let executed = 0;
  const serve = () => createServer((req, res) => { void gate.gateHttpRequest(req, res, async () => { executed++; res.writeHead(200); res.end(); }); });
  const tcp = serve(), unix = serve();
  try {
    tcp.listen(0, "127.0.0.1"); unix.listen(join(dir, "broker.sock")); await Promise.all([once(tcp, "listening"), once(unix, "listening")]);
    const port = (tcp.address() as { port: number }).port;
    for (const [route, tier] of Object.entries(meshRouteMatrixEntries())) {
      if (tier === "public") continue;
      const [method, template] = route.split(" "), path = template!.replace(/:[^/]+/g, "test-id");
      for (const socketPath of [undefined, join(dir, "broker.sock")]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest({ ...(socketPath ? { socketPath } : { hostname: "127.0.0.1", port }), method, path }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end();
        });
        expect(status).toBeGreaterThanOrEqual(400);
      }
    }
    expect(executed).toBe(0);
  } finally { await Promise.all([new Promise((resolve) => tcp.close(resolve)), new Promise((resolve) => unix.close(resolve))]); rmSync(dir, { recursive: true, force: true }); }
});
