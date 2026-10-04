import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessTestFixture, accessTestKey } from "../../../runtime/src/test-helpers/access-fixture.test.ts";
import { ACCESS_PROTOCOL, signAccessArtifact, validateAccessGrant, type AccessPolicy, type AccessDelegation } from "../../../runtime/src/mesh-access.js";
import { buildSignedNodeCard, nodeKeyId } from "../../../runtime/src/node-identity.js";
import { hashGatewayPassword, loadGatewayConfig, loadGatewayCredentials, privateText, withoutGatewaySecrets } from "./config.ts";
import { createGatewayManage } from "./manage.ts";
import { createScopedAccessGateway } from "./server.ts";
import { createGatewayBroker, type GatewayBroker } from "./broker-client.ts";

const password = "synthetic gateway password only";
const passwordHash = await hashGatewayPassword(password);
const unsigned = <T extends { signature: string }>(value: T): Omit<T, "signature"> => { const { signature: _, ...rest } = value; return rest; };
function fixture() {
  const node = accessTestKey(), f = accessTestFixture(nodeKeyId(node.publicKey));
  let clock = f.now;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "scoped-gateway-unit-"))); chmodSync(directory, 0o700);
  const write = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const delegation = signAccessArtifact<AccessDelegation>(f.admin, { ...unsigned(f.delegation), principalId: f.adminPrincipal.id });
  const user = { login: "admin", passwordHash, deviceFile: write("device.json", { protocol: ACCESS_PROTOCOL, kind: "private-device", identity: f.device }),
    delegationFile: write("delegation.json", delegation), principalFile: write("principal.json", { protocol: ACCESS_PROTOCOL, kind: "private-identity", identity: f.admin, principal: f.adminPrincipal }) };
  const uid = process.getuid!();
  const input = { privateDirectory: directory, isolation: { gatewayUid: uid, brokerUid: uid + 1, agentUids: [uid + 2] },
    origin: "https://access.unit.test:43210", brokerUrl: "http://127.0.0.1:43110", audience: f.audience,
    tls: { certFile: write("cert.pem", "synthetic public cert"), keyFile: write("key.pem", "synthetic TLS private key") }, users: [user], sessionTtlSeconds: 600, idleTtlSeconds: 60 };
  const configPath = write("config.json", input), config = loadGatewayConfig(configPath);
  const staticRoot = join(directory, "static"); mkdirSync(staticRoot); mkdirSync(join(staticRoot, "assets"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>access</title>");
  writeFileSync(join(staticRoot, "assets", "app.js"), "console.log('static fixture')");
  let status: any = { network: { id: f.policy.networkId, revision: 1, expiresAt: f.policy.expiresAt }, viewer: { principal: f.adminPrincipal, role: "admin" }, canAdmin: true,
    policy: f.policy, grants: [], delegations: [delegation], devices: [{ keyId: nodeKeyId(f.device.publicKey), publicKey: f.device.publicKey, principalId: f.adminPrincipal.id }],
    resources: { agents: [{ id: "fabric", projectId: "project1", actions: ["discover", "message", "request", "read-own"] }], projects: [{ id: "project1" }] }, pagination: { offset: 0, nextOffset: null, limit: 100 } };
  const calls: Record<string, unknown>[] = [], submissions: unknown[] = [];
  const broker: GatewayBroker = { async call(_user, operation) { calls.push(operation); return operation.operation === "network.status" ? structuredClone(status) : { ok: true }; }, async submit(artifact) { submissions.push(artifact); return { imported: true }; }, close() {} };
  const now = () => clock;
  const manage = createGatewayManage(config, broker, now), gateway = createScopedAccessGateway(config, { staticRoot, broker, manage, now });
  type Browser = { cookie?: string; csrf?: string };
  async function request(path: string, browser?: Browser, body?: unknown, headers: Record<string, string> = {}, method?: string) {
    const response = await gateway.fetch(new Request(config.origin + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { host: new URL(config.origin).host,
      ...(browser?.cookie ? { cookie: browser.cookie } : {}), ...(body === undefined ? {} : { origin: config.origin, "content-type": "application/json", ...(browser?.csrf ? { "x-scout-csrf": browser.csrf } : {}) }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "127.0.0.1");
    const text = await response.text(); let json: any; try { json = JSON.parse(text); } catch {}
    if (browser) { const cookie = response.headers.get("set-cookie"); if (cookie) browser.cookie = cookie.split(";")[0]; if (json?.csrf) browser.csrf = json.csrf; }
    return { response, status: response.status, text, json };
  }
  async function login() { const browser: Browser = {}; await request("/api/access/session", browser); expect((await request("/api/access/login", browser, { login: user.login, password })).status).toBe(200); return browser; }
  const grant = () => ({ action: "grant.save", subjectId: f.subject.id, scope: { all: false, agentIds: ["fabric"], projectIds: [] }, actions: ["discover", "request"], expiresAt: clock + 20_000 });
  return { ...f, node, directory, write, user, input, configPath, config, delegation, broker, manage, gateway, now, calls, submissions, grant, request, login,
    status: () => status, setStatus: (value: any) => { status = value; }, advance: (ms: number) => { clock += ms; }, close: () => { gateway.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("config requires dedicated HTTPS cookie host, separate declared UIDs, private files, and no root signer", () => {
  const f = fixture();
  try {
    for (const origin of ["http://127.0.0.1:43210", "https://127.0.0.1", "https://localhost", "https://localhost:43210", "https://machine.scout.local"]) {
      f.write("config.json", { ...f.input, origin }); expect(() => loadGatewayConfig(f.configPath)).toThrow("dedicated_https_cookie_hostname_required");
    }
    f.write("config.json", { ...f.input, isolation: { ...f.input.isolation, brokerUid: process.getuid!() } }); expect(() => loadGatewayConfig(f.configPath)).toThrow("gateway_uid_must_differ");
    f.write("config.json", { ...f.input, isolation: { ...f.input.isolation, agentUids: [process.getuid!()] } }); expect(() => loadGatewayConfig(f.configPath)).toThrow("gateway_uid_must_differ");
    f.write("config.json", f.input); chmodSync(f.directory, 0o755); expect(() => loadGatewayConfig(f.configPath)).toThrow("0700"); chmodSync(f.directory, 0o700);
    chmodSync(f.user.deviceFile, 0o644); expect(() => loadGatewayCredentials(f.user, f.audience)).toThrow("owner_only"); chmodSync(f.user.deviceFile, 0o600);
    symlinkSync(f.user.deviceFile, join(f.directory, "symlink.json")); expect(() => privateText(join(f.directory, "symlink.json"))).toThrow("owner_only");
    const rootDelegation = signAccessArtifact<AccessDelegation>(f.owner, { ...unsigned(f.delegation), principalId: f.policy.root.id });
    f.write("delegation.json", rootDelegation); f.write("principal.json", { protocol: ACCESS_PROTOCOL, kind: "private-identity", principal: f.policy.root, identity: { privateKey: "must never be parsed" } });
    expect(() => loadGatewayCredentials(f.user, f.audience)).toThrow("root_signing_key_forbidden");
    f.write("device.json", { protocol: ACCESS_PROTOCOL, kind: "private-device", identity: f.owner });
    expect(() => loadGatewayCredentials(f.user, f.audience)).toThrow("root_signing_key_forbidden");
    expect(withoutGatewaySecrets({ PATH: "/bin", SCOUT_LOCAL_ADMIN_KEY_FILE: "/secret", OPENSCOUT_ACCESS_GATEWAY_CONFIG: "/private", PRINCIPAL_FILE: "secret" })).toEqual({ PATH: "/bin" });
  } finally { f.close(); }
});

test("anonymous CSRF, exact Host/Origin, cookie rotation, safe headers and isolated route inventory", async () => {
  const f = fixture();
  try {
    const browser: { cookie?: string; csrf?: string } = {};
    const session = await f.request("/api/access/session", browser);
    expect(session.json.authenticated).toBe(false); expect(session.json.csrf).toHaveLength(43);
    for (const value of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "__Host-scout-access="]) expect(session.response.headers.get("set-cookie")).toContain(value);
    const anonymousCookie = browser.cookie, anonymousCsrf = browser.csrf;
    expect((await f.request("/api/access/login", undefined, { login: "admin", password })).status).toBe(403);
    expect((await f.request("/api/access/login", browser, { login: "admin", password }, { "x-scout-csrf": "" })).status).toBe(403);
    const login = await f.request("/api/access/login", browser, { login: "admin", password }); expect(login.status).toBe(200);
    expect(browser.cookie).not.toBe(anonymousCookie); expect(browser.csrf).not.toBe(anonymousCsrf);
    expect(login.json.expiresAt).toBe(f.delegation.expiresAt); expect(login.json.user.canSign).toBe(true);
    for (const headers of [{ host: "evil.test" }, { origin: "https://evil.test" }, { "sec-fetch-site": "same-site" }, { upgrade: "websocket" }, { "x-scout-csrf": "" }]) expect((await f.request("/api/access/rpc", browser, { operation: "whoami" }, headers)).status).toBe(403);
    for (const path of ["/trpc", "/v1/access/admin", "/api/terminal", "/api/proxy", "/api/access/unknown", "/assets/secret.json", "/assets/%2e%2e%2fprincipal.json"]) expect((await f.request(path, browser)).status).toBe(404);
    expect((await f.request("/api/access/rpc", browser, { operation: "whoami", actorId: "owner" })).status).toBe(400);
    expect((await f.request("/api/access/rpc", browser, { operation: "enroll" })).status).toBe(400);
    expect((await f.request("/api/access/rpc", browser, { operation: "network.status", offset: 100 })).status).toBe(200);
    expect((await f.request("/api/access/rpc", browser, { operation: "network.status", offset: -1 })).status).toBe(400);
    const page = await f.request("/", browser); expect(page.status).toBe(200); expect(page.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.response.headers.get("content-security-policy")).not.toContain("unsafe-inline"); expect(page.response.headers.get("access-control-allow-origin")).toBeNull();
    const asset = join(f.directory, "static", "assets", "app.js"), assets = join(f.directory, "static", "assets");
    chmodSync(asset, 0o666); expect((await f.request("/assets/app.js", browser)).status).toBe(404); chmodSync(asset, 0o644);
    chmodSync(assets, 0o777); expect((await f.request("/assets/app.js", browser)).status).toBe(404); chmodSync(assets, 0o755);
    chmodSync(join(f.directory, "static"), 0o777); expect((await f.request("/", browser)).status).toBe(404); chmodSync(join(f.directory, "static"), 0o755);
    expect((await f.request("/assets/app.js", browser)).status).toBe(200);
    expect(login.text).not.toContain(f.admin.privateKey); expect(login.text).not.toContain(f.device.privateKey); expect(login.text).not.toContain(f.user.passwordHash);
    expect((await f.request("/api/access/logout", browser, {})).status).toBe(200);
    expect((await f.request("/api/access/rpc", browser, { operation: "whoami" })).status).toBe(403);
  } finally { f.close(); }
});

test("session absolute expiration never outlives configured delegation", async () => {
  const f = fixture();
  try { const browser = await f.login(); f.advance(40_001); expect((await f.request("/api/access/session", browser)).json.authenticated).toBe(false); }
  finally { f.close(); }
});

test("management requires public preview, password each time, single use, and exact fresh authority", async () => {
  const f = fixture();
  try {
    const browser = await f.login(), preview = await f.request("/api/access/manage/preview", browser, f.grant());
    expect(preview.status).toBe(200); expect(preview.json.artifact.signature).toBeUndefined(); expect(preview.json.warnings[0]).toContain("OS authority");
    expect(f.submissions).toHaveLength(0);
    expect((await f.request("/api/access/manage", browser, { previewId: preview.json.previewId, password, artifact: preview.json.artifact })).status).toBe(400);
    expect((await f.request("/api/access/manage", browser, { previewId: preview.json.previewId, password })).status).toBe(200);
    expect(f.submissions).toHaveLength(1); validateAccessGrant(f.submissions[0] as any, f.policy, f.now());
    expect((await f.request("/api/access/manage", browser, { previewId: preview.json.previewId, password })).status).toBe(409);
    const stale = await f.request("/api/access/manage/preview", browser, f.grant());
    const updatedPolicy = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2 });
    f.setStatus({ ...f.status(), policy: updatedPolicy, network: { ...f.status().network, revision: 2 } });
    expect((await f.request("/api/access/manage", browser, { previewId: stale.json.previewId, password })).status).toBe(409);
    expect(f.submissions).toHaveLength(1);
    const failed = await f.request("/api/access/manage/preview", browser, f.grant());
    expect((await f.request("/api/access/manage", browser, { previewId: failed.json.previewId, password: "wrong" })).status).toBe(401);
    expect((await f.request("/api/access/manage", browser, { previewId: failed.json.previewId, password })).status).toBe(409);
    expect(f.submissions).toHaveLength(1);
  } finally { f.close(); }
});

test("grants require current full admin authority, non-self member and canonical selectors; no root minting", async () => {
  const f = fixture();
  try {
    for (const input of [{ ...f.grant(), subjectId: f.adminPrincipal.id }, { ...f.grant(), subjectId: "unknown" }, { ...f.grant(), scope: { all: false, agentIds: ["unregistered"], projectIds: [] } }]) await expect(f.manage.prepare(f.user, input)).rejects.toThrow("management_not_authorized");
    await expect(f.manage.prepare(f.user, { ...f.grant(), actions: ["admin"] })).rejects.toThrow("invalid_actions");
    await expect(f.manage.prepare(f.user, { action: "principal.add", principal: f.subject })).rejects.toThrow("unsupported_management_action");
    await expect(f.manage.prepare(f.user, { action: "revoke", kind: "principal", id: f.subject.id })).rejects.toThrow("require_cli_signed_policy");
    f.setStatus({ ...f.status(), canAdmin: false, policy: undefined }); await expect(f.manage.prepare(f.user, f.grant())).rejects.toThrow("management_not_authorized");
    f.setStatus({ ...f.status(), canAdmin: true, policy: f.policy, viewer: { principal: f.adminPrincipal, role: "member" } }); await expect(f.manage.prepare(f.user, f.grant())).rejects.toThrow("management_not_authorized");
    const { principalFile: _, ...readonly } = f.user; await expect(f.manage.prepare(readonly, f.grant())).rejects.toThrow("principal_signer_unavailable");
  } finally { f.close(); }
});

test("device approval narrows configured scope/actions/lifetime and non-admin cannot mint admin", async () => {
  const f = fixture();
  try {
    const narrow = signAccessArtifact<AccessDelegation>(f.admin, { ...unsigned(f.delegation), scope: { all: false, agentIds: ["fabric"], projectIds: [] }, actions: ["discover", "request"] });
    f.write("delegation.json", narrow); f.setStatus({ ...f.status(), policy: undefined, canAdmin: false });
    const input = { action: "device.approve", devicePublicKey: accessTestKey().publicKey, scope: narrow.scope, actions: ["discover"], expiresAt: f.now() + 20_000 };
    const preview = await f.manage.prepare(f.user, input); expect(preview.artifact.principalId).toBe(f.adminPrincipal.id); expect(preview.artifact.signature).toBeUndefined();
    await expect(f.manage.prepare(f.user, { ...input, scope: { all: true, agentIds: [], projectIds: [] } })).rejects.toThrow("management_not_authorized");
    await expect(f.manage.prepare(f.user, { ...input, scope: { all: false, agentIds: [], projectIds: ["project1"] } })).rejects.toThrow("management_not_authorized");
    await expect(f.manage.prepare(f.user, { ...input, actions: ["admin"] })).rejects.toThrow("management_not_authorized");
    await expect(f.manage.prepare(f.user, { ...input, expiresAt: narrow.expiresAt + 1 })).rejects.toThrow("expiry_exceeds_authority");
    await f.manage.execute(f.user, preview); expect(f.calls.at(-1)?.operation).toBe("device.approve"); expect((f.calls.at(-1)?.artifact as any).signature).toBeDefined();
  } finally { f.close(); }
});

test("policy changes only forward a valid monotonic CLI-signed same-network artifact, without a root key", async () => {
  const f = fixture();
  try {
    const policy = signAccessArtifact<AccessPolicy>(f.owner, { ...unsigned(f.policy), revision: 2, members: f.policy.members.slice(1) });
    const { principalFile: _, ...readonly } = f.user;
    const preview = await f.manage.prepare(readonly, { action: "policy.submit", artifact: policy });
    expect(preview.artifact).toEqual(policy); await f.manage.execute(readonly, preview); expect(f.submissions).toEqual([policy]);
    await expect(f.manage.prepare(f.user, { action: "policy.submit", artifact: f.policy })).rejects.toThrow("policy_must_advance");
    await expect(f.manage.prepare(f.user, { action: "policy.submit", artifact: { ...policy, signature: "bad" } })).rejects.toThrow("invalid_signed_policy");
    const other = accessTestFixture(f.audience).policy; await expect(f.manage.prepare(f.user, { action: "policy.submit", artifact: other })).rejects.toThrow("policy_must_advance");
  } finally { f.close(); }
});

test("broker client fails closed before signing on missing pin, wrong card audience/capability or unsigned response", async () => {
  const f = fixture();
  try {
    expect(() => createGatewayBroker({ ...f.config, brokerUrl: "http://remote.example.test" })).toThrow("https_required");
    expect(() => createGatewayBroker({ ...f.config, brokerUrl: "https://remote.example.test" })).toThrow("broker_tls_pin_required");
    let requests = 0;
    const card = buildSignedNodeCard(f.node, { nodeId: "test", label: "test", version: "test", capabilities: [], endpoints: [] });
    const client = createGatewayBroker(f.config, { fetch: (async (_url, init) => { requests++; expect(init?.method).toBe("GET"); return Response.json({ card }); }) as typeof fetch });
    try { await expect(client.call(f.user, { operation: "whoami" })).rejects.toThrow("broker_identity_or_capability_mismatch"); expect(requests).toBe(1); } finally { client.close(); }
    const pin = "ab".repeat(32), seen: unknown[] = [];
    const pinned = { async fetch(_url: string, peer: unknown, init: RequestInit) { seen.push(peer); expect(init.method).toBe("GET"); return Response.json({ card: { ...card, capabilities: [ACCESS_PROTOCOL] } }); }, close() {} };
    const remote = createGatewayBroker({ ...f.config, brokerUrl: "https://remote.example.test", tlsPin: pin }, { pinned: pinned as any });
    try { await expect(remote.call(f.user, { operation: "whoami" })).rejects.toThrow("broker_identity_or_capability_mismatch"); expect(seen).toEqual([{ spkiFingerprint: pin, expectedKeyId: f.audience }]); } finally { remote.close(); }
  } finally { f.close(); }
});

test("idle expiry, login backoff, bounded bodies and exception redaction remain enforced", async () => {
  const f = fixture();
  try {
    f.write("delegation.json", signAccessArtifact<AccessDelegation>(f.admin, { ...unsigned(f.delegation), expiresAt: f.now() + 300_000 }));
    const browser = await f.login();
    expect((await f.request("/api/access/rpc", browser, { operation: "message", body: "x".repeat(262145) })).status).toBe(413);
    const call = f.broker.call;
    f.broker.call = async () => { throw new Error(`private error ${f.device.privateKey}`); };
    const error = await f.request("/api/access/rpc", browser, { operation: "whoami" }); expect(error.status).toBe(500); expect(error.text).toBe('{"error":"gateway_request_failed"}');
    f.broker.call = call;
    f.advance(60_001); expect((await f.request("/api/access/session", browser)).json.authenticated).toBe(false);
    expect((await f.request("/api/access/login", browser, { login: "admin", password: "wrong" })).json.error).toBe("invalid_login");
    expect((await f.request("/api/access/login", browser, { login: "admin", password })).status).toBe(429);
    f.advance(1_001); expect((await f.request("/api/access/login", browser, { login: "admin", password })).status).toBe(200);
    const prepared = await f.request("/api/access/manage/preview", browser, { ...f.grant(), expiresAt: f.now() + 1_000 });
    // The original short-lived policy has now expired. No preview/signature is
    // produced by the management layer even though its browser session is live.
    expect(prepared.status).not.toBe(200); expect(f.submissions).toHaveLength(0);
  } finally { f.close(); }
});
