import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_PROTOCOL, signAccessArtifact, type AccessDelegation, type AccessPolicy } from "../../../runtime/src/mesh-access.js";
import { MeshAccessStore } from "../../../runtime/src/mesh-access-store.js";
import { createMeshIngressGate } from "../../../runtime/src/mesh-ingress-gate.js";
import { PeerNonceCache } from "../../../runtime/src/mesh-peer-auth.js";
import { buildSignedNodeCard, nodeKeyId, type NodeIdentity } from "../../../runtime/src/node-identity.js";
import { loadOrCreateTlsIdentity } from "../../../runtime/src/node-tls-identity.js";
import { handleBrokerAccessRoute, type BrokerAccessHttpDeps } from "../../../runtime/src/broker-access-http-routes.js";
import { accessTestFixture, accessTestKey } from "../../../runtime/src/test-helpers/access-fixture.test.ts";
import { hashGatewayPassword, loadGatewayConfig, loadGatewayCredentials } from "./config.ts";
import { createGatewayBroker } from "./broker-client.ts";
import { createGatewayManage } from "./manage.ts";
import { createScopedAccessGateway } from "./server.ts";

const unsigned = <T extends { signature: string }>(value: T): Omit<T, "signature"> => { const { signature: _, ...rest } = value; return rest; };
const password = "synthetic integration password only";

/** Real HTTP, signatures, ingress, SQLite and gateway authentication. Only work execution uses a synthetic recorder. */
async function fixture(gatewayNow: () => number = Date.now) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "scoped-gateway-integration-")));
  chmodSync(directory, 0o700);
  const cleanup: (() => void | Promise<void>)[] = [() => rmSync(directory, { recursive: true, force: true })];
  const close = async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); };
  try {
  const write = (name: string, value: unknown) => {
    const path = join(directory, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const node = accessTestKey(), f = accessTestFixture(nodeKeyId(node.publicKey));
  const limited = accessTestKey(), limitedDevice = accessTestKey(), adminDevice = accessTestKey();
  const limitedPrincipal = { id: nodeKeyId(limited.publicKey), publicKey: limited.publicKey, kind: "person" as const, label: "Limited admin" };
  const policy = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy),
    members: [...f.policy.members, { principal: limitedPrincipal, role: "admin" }] });
  const db = new Database(":memory:"), store = new MeshAccessStore(db, f.audience);
  cleanup.push(() => db.close());
  store.importPolicy(policy, true, f.now); store.importGrant(f.grant, f.now);
  const projectRoot = join(directory, "private-project"); mkdirSync(projectRoot, { mode: 0o700 });
  store.enroll({ networkId: policy.networkId, agentIds: ["fabric", "secret"], projects: [] }, new Set([projectRoot]), new Set(["fabric", "secret"]));
  const invocations = new Map<string, any>(), flights = new Map<string, any>(), messages: any[] = [], brokerPaths: string[] = [];
  const deps: BrokerAccessHttpDeps = {
    access: store, nodeId: "integration-broker", nodeKeyId: f.audience, enforced: () => true,
    listAgents: () => [{ id: "fabric", displayName: "Fabric", projectRoot }, { id: "secret", displayName: "Secret", projectRoot }],
    ensureGuestActor: async () => {}, openThread: async ({ requesterId, targetAgentId }) => ({ id: `thread-${requesterId}-${targetAgentId}` } as any),
    postMessage: async (message) => { messages.push(message); },
    invoke: async (invocation) => { invocations.set(invocation.id!, invocation); flights.set(invocation.id!, { state: "completed", summary: "Synthetic work completed", output: "integration-result" }); },
    existingInvocation: (id) => invocations.get(id), flightForInvocation: (id) => flights.get(id),
    ingressPosture: async () => { throw new Error("Remote projections must not run posture probes"); },
  };
  const gate = createMeshIngressGate({ localAdminKey: "ab".repeat(32), mode: "verify-warn", destinationKeyId: f.audience,
    bootedAt: f.now - 1000, lookupPeer: () => undefined, nonceClaim: new PeerNonceCache(), logger: { warn() {} },
    scopedAccess: { knownDevice: (id) => store.knownDevice(id), verify: (body: any) => store.verifyDelegation(body.delegation), accept: (proof) => store.acceptDelegation(proof.delegation) } });
  const brokerServer = createServer((request, response) => {
    brokerPaths.push(request.url!);
    void gate.gateHttpRequest(request, response, async (gatedRequest) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (url.pathname === "/v1/node") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ card: buildSignedNodeCard(node, { nodeId: "integration-broker", label: "Isolated test broker", version: "test", capabilities: [ACCESS_PROTOCOL], endpoints: [] }) }));
      } else if (!await handleBrokerAccessRoute(gatedRequest, response, url, request.method!, deps)) { response.writeHead(404); response.end(); }
    }).catch(() => { response.writeHead(500); response.end(); });
  });
  brokerServer.listen(0, "127.0.0.1"); await once(brokerServer, "listening");
  cleanup.push(async () => { brokerServer.closeAllConnections(); await new Promise<void>((resolve) => brokerServer.close(() => resolve())); });
  const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;
  const tls = await loadOrCreateTlsIdentity(directory, { algorithm: "ec-p256" });
  const certFile = write("gateway-cert.pem", tls.certificatePem), keyFile = write("gateway-key.pem", tls.keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  let gateway: ReturnType<typeof createScopedAccessGateway>;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.certificatePem, key: tls.keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
    fetch: (request, server) => gateway.fetch(request, server.requestIP(request)?.address ?? "unknown") });
  cleanup.push(() => listener.stop(true));
  const origin = `https://access.integration.test:${listener.port}`;
  const passwordHash = await hashGatewayPassword(password);
  function user(login: string, key: NodeIdentity, principal: typeof f.subject, device: NodeIdentity, delegation: AccessDelegation) {
    return { login, passwordHash, deviceFile: write(`${login}-device.json`, { protocol: ACCESS_PROTOCOL, kind: "private-device", identity: device }),
      delegationFile: write(`${login}-delegation.json`, delegation),
      principalFile: write(`${login}-principal.json`, { protocol: ACCESS_PROTOCOL, kind: "private-identity", identity: key, principal }) };
  }
  const memberUser = user("member", f.service, f.subject, f.device, f.delegation);
  const adminDelegation = signAccessArtifact<AccessDelegation>(f.admin, { ...unsigned(f.delegation), id: "admin-device", principalId: f.adminPrincipal.id, devicePublicKey: adminDevice.publicKey });
  const adminUser = user("admin", f.admin, f.adminPrincipal, adminDevice, adminDelegation);
  const limitedDelegation = signAccessArtifact<AccessDelegation>(limited, { ...unsigned(f.delegation), id: "limited-admin-device", principalId: limitedPrincipal.id, devicePublicKey: limitedDevice.publicKey, actions: ["discover", "read-own"] });
  const limitedUser = user("limited", limited, limitedPrincipal, limitedDevice, limitedDelegation);
  const uid = process.getuid!();
  const configPath = write("gateway-config.json", { privateDirectory: directory,
    isolation: { gatewayUid: uid, brokerUid: uid + 1, agentUids: [uid + 2] }, origin, listenHost: "127.0.0.1", brokerUrl,
    audience: f.audience, tls: { certFile, keyFile }, users: [memberUser, adminUser, limitedUser], sessionTtlSeconds: 600, idleTtlSeconds: 300 });
  const config = loadGatewayConfig(configPath), broker = createGatewayBroker(config);
  const staticRoot = join(directory, "static"); mkdirSync(staticRoot); writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Isolated integration</title>");
  gateway = createScopedAccessGateway(config, { staticRoot, broker, manage: createGatewayManage(config, broker), now: gatewayNow });
  cleanup.push(() => gateway.close());
  type Browser = { cookie?: string; csrf?: string };
  async function request(path: string, options: { browser?: Browser; body?: unknown; headers?: Record<string, string>; method?: string } = {}) {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = { host: new URL(origin).host, ...(options.browser?.cookie ? { cookie: options.browser.cookie } : {}),
      ...(body !== undefined ? { origin, "content-type": "application/json", ...(options.browser?.csrf ? { "x-scout-csrf": options.browser.csrf } : {}) } : {}), ...options.headers };
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; json: any }>((resolve, reject) => {
      // Trust only this fixture's certificate. Its generated SAN is unrelated to the synthetic test hostname.
      const req = httpsRequest({ hostname: "127.0.0.1", port: listener.port, path, method: options.method ?? (body === undefined ? "GET" : "POST"),
        ca: tls.certificatePem, checkServerIdentity: () => undefined, headers }, (response) => {
        const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => {
          const text = Buffer.concat(chunks).toString(); let json: any; try { json = JSON.parse(text); } catch {}
          const cookie = response.headers["set-cookie"]?.[0]; if (cookie && options.browser) options.browser.cookie = cookie.split(";")[0];
          if (json?.csrf && options.browser) options.browser.csrf = json.csrf;
          resolve({ status: response.statusCode!, headers: response.headers, text, json });
        });
      }); req.on("error", reject); req.end(body);
    });
  }
  async function login(login: string) {
    const browser: Browser = {};
    const session = await request("/api/access/session", { browser });
    expect(session.status).toBe(200); expect(session.json.authenticated).toBe(false); expect(browser.csrf).toBeDefined();
    const anonymousCookie = browser.cookie;
    const response = await request("/api/access/login", { browser, body: { login, password } });
    expect(response.status).toBe(200); expect(response.json.authenticated).toBe(true); expect(browser.cookie).not.toBe(anonymousCookie);
    return browser;
  }
  return { ...f, policy, store, db, request, login, origin, brokerUrl, brokerPaths, messages, invocations, flights, write, limitedUser, limitedDelegation, limited, memberUser,
    close };
  } catch (error) { await close(); throw error; }
}

test("real isolated broker and gateway enforce sessions, projections, scope and revocation end to end", async () => {
  const f = await fixture();
  try {
    expect((await f.request("/api/access/rpc", { body: { operation: "network.status" } })).status).toBe(403);
    const anonymous = {};
    await f.request("/api/access/session", { browser: anonymous });
    expect((await f.request("/api/access/rpc", { browser: anonymous, body: { operation: "network.status" } })).status).toBe(401);
    expect((await f.request("/api/access/login", { body: { login: "admin", password } })).status).toBe(403);
    expect((await fetch(f.brokerUrl + "/v1/snapshot")).status).toBe(403);
    const member = await f.login("member"), admin = await f.login("admin"), limited = await f.login("limited");
    const call = (browser: typeof member, operation: string, fields: Record<string, unknown> = {}) => f.request("/api/access/rpc", { browser, body: { operation, ...fields } });
    const status = await call(member, "network.status");
    expect(status.status).toBe(200); expect(status.json.canAdmin).toBe(false); expect(status.json.policy).toBeUndefined();
    expect(status.json.principals.map((p: any) => p.principal.id)).toEqual([f.subject.id]);
    expect(status.json.grants.every((g: any) => g.subjectId === f.subject.id)).toBe(true);
    expect(status.json.devices.every((d: any) => d.principalId === f.subject.id)).toBe(true);
    expect(status.json.delegations.every((d: any) => d.principalId === f.subject.id)).toBe(true);
    expect(status.text).not.toContain("private-project"); expect(status.text).not.toContain("privateKey"); expect(status.text).not.toContain(f.adminPrincipal.publicKey);
    expect((await call(member, "discover")).json.agents.map((a: any) => a.id)).toEqual(["fabric"]);
    expect((await call(member, "request", { requestId: "outside_123", target: "secret", body: "must not execute" })).status).toBe(404);
    expect((await call(member, "request", { requestId: "missing_123", target: "missing", body: "must not execute" })).status).toBe(404);
    const work = await call(member, "request", { requestId: "member_work1", target: "fabric", body: "synthetic bounded work" });
    expect(work.status).toBe(200); expect(work.json.accepted).toBe(true);
    expect((await call(member, "work.list")).json.work.map((w: any) => w.id)).toEqual([work.json.invocationId]);
    expect((await call(admin, "work.list")).json.work).toEqual([]);
    expect((await call(member, "result", { workId: work.json.invocationId })).json.output).toBe("integration-result");
    expect((await call(admin, "result", { workId: work.json.invocationId })).status).toBe(404);
    expect((await call(limited, "network.status")).json.canAdmin).toBe(false);
    const grantInput = { action: "grant.save", subjectId: f.subject.id, scope: { all: false, agentIds: ["secret"], projectIds: [] }, actions: ["discover", "request", "read-own"], expiresAt: Date.now() + 20_000 };
    expect((await f.request("/api/access/manage/preview", { browser: limited, body: grantInput })).status).toBe(403);
    f.write("limited-delegation.json", signAccessArtifact<AccessDelegation>(f.limited, { ...unsigned(f.limitedDelegation), id: "limited-admin-scope", actions: ["discover", "admin"], scope: { all: false, agentIds: ["fabric"], projectIds: [] } }));
    expect((await call(limited, "network.status")).json.canAdmin).toBe(false);
    expect((await f.request("/api/access/manage/preview", { browser: limited, body: grantInput })).status).toBe(403);
    const preview = await f.request("/api/access/manage/preview", { browser: admin, body: grantInput });
    expect(preview.status).toBe(200); expect(preview.json.previewId).toBeDefined(); expect(preview.json.artifact.subjectId).toBe(f.subject.id);
    expect((await f.request("/api/access/manage", { browser: admin, body: { previewId: preview.json.previewId, password } })).status).toBe(200);
    expect((await call(member, "discover")).json.agents.map((a: any) => a.id).sort()).toEqual(["fabric", "secret"]);
    const withdraw = await f.request("/api/access/manage/preview", { browser: admin, body: { action: "revoke", kind: "grant", id: preview.json.artifact.id } });
    expect(withdraw.status).toBe(200);
    expect((await f.request("/api/access/manage", { browser: admin, body: { previewId: withdraw.json.previewId, password } })).status).toBe(200);
    expect((await call(member, "discover")).json.agents.map((a: any) => a.id)).toEqual(["fabric"]);
    const selfRevoke = await f.request("/api/access/manage/preview", { browser: member, body: { action: "revoke", kind: "delegation", id: f.delegation.id } });
    expect(selfRevoke.status).toBe(200);
    expect((await f.request("/api/access/manage", { browser: member, body: { previewId: selfRevoke.json.previewId, password } })).status).toBe(200);
    expect((await call(member, "whoami")).status).toBe(403);
    for (const path of ["/trpc", "/v1/access/admin", "/v1/snapshot", "/api/terminal", "/api/mesh/proxy"]) expect((await f.request(path, { browser: admin })).status).toBe(404);
    expect((await f.request("/api/access/rpc", { browser: admin, body: { operation: "status" } })).status).toBe(400);
    expect((await f.request("/api/access/rpc", { browser: admin, body: { operation: "whoami", principalId: f.subject.id } })).status).toBe(400);
    expect((await f.request("/api/access/rpc", { browser: admin, body: { operation: "whoami" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await f.request("/api/access/rpc", { browser: admin, body: { operation: "whoami" }, headers: { "x-scout-csrf": "" } })).status).toBe(403);
    expect(f.brokerPaths.filter((p) => !["/v1/node", "/v1/access/rpc", "/v1/access/policy", "/v1/snapshot"].includes(p))).toEqual([]);
    expect(status.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(status.headers["access-control-allow-origin"]).toBeUndefined();
    const badStepUp = await f.request("/api/access/manage/preview", { browser: admin, body: grantInput });
    expect(badStepUp.status).toBe(200);
    const grantCount = f.store.grants(f.policy.networkId).length;
    expect((await f.request("/api/access/manage", { browser: admin, body: { previewId: badStepUp.json.previewId, password: "incorrect password" } })).status).toBe(401);
    expect((await f.request("/api/access/manage", { browser: admin, body: { previewId: badStepUp.json.previewId, password } })).status).toBe(409);
    expect(f.store.grants(f.policy.networkId)).toHaveLength(grantCount);
    const demoted = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2,
      members: f.policy.members.map((m) => m.principal.id === f.adminPrincipal.id ? { ...m, role: "member" as const } : m) });
    expect((await fetch(f.brokerUrl + "/v1/access/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact: demoted }) })).status).toBe(200);
    const downgraded = await call(admin, "network.status");
    expect(downgraded.status).toBe(200); expect(downgraded.json.canAdmin).toBe(false); expect(downgraded.json.policy).toBeUndefined();
    expect((await f.request("/api/access/manage/preview", { browser: admin, body: grantInput })).status).toBe(403);
    const rootDevice = accessTestKey();
    const rootUser = { ...f.memberUser,
      deviceFile: f.write("forbidden-root-device.json", { protocol: ACCESS_PROTOCOL, kind: "private-device", identity: rootDevice }),
      delegationFile: f.write("forbidden-root-delegation.json", signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(f.delegation), id: "forbidden-root", principalId: f.policy.root.id, devicePublicKey: rootDevice.publicKey })),
      principalFile: f.write("forbidden-root-private.json", { protocol: ACCESS_PROTOCOL, kind: "private-identity", identity: f.owner, principal: f.policy.root }) };
    expect(() => loadGatewayCredentials(rootUser, f.audience)).toThrow("root_signing_key_forbidden");
  } finally { await f.close(); }
}, 30_000);

test("real gateway renews expired anonymous tokens and supports logout followed by login", async () => {
  // Start only the gateway session clock in the past, then advance to real time.
  // Broker policy and delegation verification retain their real clocks throughout.
  let gatewayTime = Date.now() - 6 * 60_000;
  const f = await fixture(() => gatewayTime);
  try {
    const browser: { cookie?: string; csrf?: string } = {};
    const firstSession = await f.request("/api/access/session", { browser });
    expect(firstSession.status).toBe(200);
    expect(firstSession.json.authenticated).toBe(false);
    const expiredCookie = browser.cookie, expiredCsrf = browser.csrf;
    gatewayTime = Date.now();
    const expiredLogin = await f.request("/api/access/login", { browser, body: { login: "member", password } });
    expect(expiredLogin.status).toBe(403);
    expect(expiredLogin.json.error).toBe("csrf_required");

    // This is the UI's CSRF-error recovery: bootstrap, then let the user resubmit.
    const renewed = await f.request("/api/access/session", { browser });
    expect(renewed.status).toBe(200);
    expect(renewed.json.authenticated).toBe(false);
    expect(browser.cookie).not.toBe(expiredCookie);
    expect(browser.csrf).not.toBe(expiredCsrf);
    const login = await f.request("/api/access/login", { browser, body: { login: "member", password } });
    expect(login.status).toBe(200);
    expect(login.json.authenticated).toBe(true);
    const authenticatedCookie = browser.cookie, authenticatedCsrf = browser.csrf;

    const logout = await f.request("/api/access/logout", { browser, body: {} });
    expect(logout.status).toBe(200);
    expect(logout.json.authenticated).toBe(false);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
    const replay = await f.request("/api/access/rpc", {
      browser: { cookie: authenticatedCookie, csrf: authenticatedCsrf }, body: { operation: "network.status" },
    });
    expect(replay.status).toBe(403);
    expect(replay.json.error).toBe("csrf_required");

    // Logout's UI finally block obtains a new anonymous cookie and CSRF token.
    const afterLogout = await f.request("/api/access/session", { browser });
    expect(afterLogout.status).toBe(200);
    expect(afterLogout.json.authenticated).toBe(false);
    expect(browser.csrf).not.toBe(authenticatedCsrf);
    const relogin = await f.request("/api/access/login", { browser, body: { login: "member", password } });
    expect(relogin.status).toBe(200);
    expect(relogin.json.authenticated).toBe(true);
    expect(browser.cookie).not.toBe(authenticatedCookie);
    expect(browser.csrf).not.toBe(authenticatedCsrf);
    const status = await f.request("/api/access/rpc", { browser, body: { operation: "network.status" } });
    expect(status.status).toBe(200);
    expect(status.json.viewer.principal.id).toBe(f.subject.id);
  } finally { await f.close(); }
}, 30_000);
