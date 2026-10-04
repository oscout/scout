import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { ActorIdentity, FlightRecord, InvocationRequest, MessageRecord } from "@openscout/protocol";

import { guestMessageId, handleBrokerGuestRoute, type BrokerGuestHttpDeps } from "./broker-guest-http-routes.js";
import { GuestGrantStore, guestActorId, guestInvocationId } from "./guest-access.js";
import {
  applyMeshGateMode,
  evaluateMeshIngress,
  type GuestAuthLookup,
} from "./mesh-ingress-gate.js";
import {
  PEER_AUTH_HEADERS,
  PeerNonceCache,
  peerRequestSigningPayload,
  sha256Hex,
  signPeerRequest,
  type PeerRequestHeaders,
} from "./mesh-peer-auth.js";
import { nodeKeyId, signNodePayload, verifyNodeSignature, type NodeIdentity } from "./node-identity.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike, RuntimeRequestTransportContext } from "./portable-types.js";

function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: Date.now(),
  };
}

function headersOf(signed: Record<string, string>): PeerRequestHeaders {
  return {
    peer: signed[PEER_AUTH_HEADERS.peer],
    ts: signed[PEER_AUTH_HEADERS.ts],
    nonce: signed[PEER_AUTH_HEADERS.nonce],
    signature: signed[PEER_AUTH_HEADERS.signature],
  };
}

function store(isPeerKey?: (keyId: string) => boolean): GuestGrantStore {
  return new GuestGrantStore(new Database(":memory:") as never, isPeerKey);
}

const NOW = 1_800_000_000_000;

describe("guest grant store", () => {
  test("installs a grant bound to one Ed25519 key with a full-key actor", () => {
    const grants = store();
    const guest = identity();
    const { grant, created } = grants.install({
      requestId: "req-1", clientPublicKey: guest.publicKey, label: "Muse", allowedTargets: ["b.agent", "a.agent"], ownerHandle: "arach",
    }, NOW);
    expect(created).toBe(true);
    expect(grant.keyId).toBe(nodeKeyId(guest.publicKey));
    expect(grant.actorId).toBe(guestActorId(grant.keyId));
    expect(grant.actorId).toHaveLength("guest.".length + 64);
    expect(grant.allowedTargets).toEqual(["a.agent", "b.agent"]);
    expect(grants.activeByKeyId(grant.keyId, NOW)?.id).toBe(grant.id);
  });

  test("distinct keys never share a coordination identity", () => {
    const grants = store();
    const one = grants.install({ requestId: "r1", clientPublicKey: identity().publicKey, label: "Muse", allowedTargets: ["a"] }, NOW).grant;
    const two = grants.install({ requestId: "r2", clientPublicKey: identity().publicKey, label: "Muse", allowedTargets: ["a"] }, NOW).grant;
    expect(one.actorId).not.toBe(two.actorId);
  });

  test("re-install of the same request is idempotent and never extends expiry", () => {
    const grants = store();
    const key = identity().publicKey;
    const input = { requestId: "req-1", clientPublicKey: key, label: "Muse", allowedTargets: ["a"], ownerHandle: "arach" };
    const first = grants.install(input, NOW).grant;
    const again = grants.install(input, NOW + 86_400_000);
    expect(again.created).toBe(false);
    expect(again.grant.id).toBe(first.id);
    expect(again.grant.expiresAt).toBe(first.expiresAt);
  });

  test("the same request with a different key, scope, owner, or label conflicts", () => {
    const grants = store();
    const key = identity().publicKey;
    const base = { requestId: "req-1", clientPublicKey: key, label: "Muse", allowedTargets: ["a"], ownerHandle: "arach" };
    grants.install(base, NOW);
    for (const change of [
      { clientPublicKey: identity().publicKey },
      { allowedTargets: ["a", "b"] },
      { ownerHandle: "someone" },
      { label: "Other" },
    ]) {
      expect(() => grants.install({ ...base, ...change }, NOW)).toThrow(/different grant/);
    }
  });

  test("a revoked request cannot be re-activated, and one key holds one active grant", () => {
    const grants = store();
    const key = identity().publicKey;
    const input = { requestId: "req-1", clientPublicKey: key, label: "Muse", allowedTargets: ["a"] };
    const grant = grants.install(input, NOW).grant;
    expect(() => grants.install({ ...input, requestId: "req-2" }, NOW)).toThrow(/already holds an active grant/);
    expect(grants.revoke({ grantId: grant.id }, NOW + 1)?.revokedAt).toBe(NOW + 1);
    expect(grants.revoke({ requestId: "req-1" }, NOW + 5)?.revokedAt).toBe(NOW + 1);
    expect(() => grants.install(input, NOW + 2)).toThrow(/revoked/);
    expect(grants.activeByKeyId(grant.keyId, NOW + 2)).toBeUndefined();
  });

  test("expired grants are inactive; expiry is capped at 30 days", () => {
    const grants = store();
    const grant = grants.install({
      requestId: "req-1", clientPublicKey: identity().publicKey, label: "Muse", allowedTargets: ["a"], expiresAt: NOW + 400 * 86_400_000,
    }, NOW).grant;
    expect(grant.expiresAt).toBe(NOW + 30 * 86_400_000);
    expect(grants.activeByKeyId(grant.keyId, grant.expiresAt)).toBeUndefined();
  });

  test("rejects non-Ed25519 keys and mesh peer keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(() => store().install({ requestId: "r", clientPublicKey: rsa, label: "x", allowedTargets: ["a"] }, NOW)).toThrow(/Ed25519/);
    const peer = identity();
    const grants = store((keyId) => keyId === nodeKeyId(peer.publicKey));
    expect(() => grants.install({ requestId: "r", clientPublicKey: peer.publicKey, label: "x", allowedTargets: ["a"] }, NOW)).toThrow(/reserved for another mesh credential/);
  });
});

function gateFixture() {
  const node = identity();
  const destinationKeyId = nodeKeyId(node.publicKey);
  const guest = identity();
  const peer = identity();
  const guestKeyId = nodeKeyId(guest.publicKey);
  const peerKeyId = nodeKeyId(peer.publicKey);
  let guestActive = true;
  const lookupGuest: GuestAuthLookup = (keyId) =>
    keyId === guestKeyId && guestActive ? { publicKey: guest.publicKey, grantId: "gg_1" } : undefined;
  const lookupPeer = (keyId: string) =>
    keyId === peerKeyId ? { publicKey: peer.publicKey, tier: "control" as const } : undefined;
  const nonceClaim = new PeerNonceCache();
  const evaluate = (input: {
    signer: NodeIdentity; method: string; path: string; body?: string; transport?: "remote" | "loopback";
    destination?: string; ts?: number; nonce?: string;
  }) => {
    const signed = signPeerRequest(input.signer, {
      method: input.method, path: input.path, body: input.body ?? "",
      destinationKeyId: input.destination ?? destinationKeyId, ts: input.ts, nonce: input.nonce,
    });
    return evaluateMeshIngress({
      transport: input.transport ?? "remote",
      method: input.method,
      pathname: new URL(input.path, "http://x").pathname,
      requestTarget: input.path,
      headers: headersOf(signed),
      body: input.body ?? "",
      destinationKeyId,
      bootedAt: Date.now() - 60_000,
      lookupPeer,
      lookupGuest,
      nonceClaim,
    });
  };
  return { guest, peer, evaluate, revokeGuest: () => { guestActive = false; } };
}

const quietLogger = { warn: () => undefined };

describe("guest ingress tier", () => {
  test("an active guest key is admitted to guest routes on remote and loopback transports", () => {
    const { guest, evaluate } = gateFixture();
    for (const transport of ["remote", "loopback"] as const) {
      const decision = evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami", transport });
      expect(decision).toMatchObject({ action: "allow", guest: { grantId: "gg_1" } });
    }
  });

  test("an unsigned request to a guest route is denied even on loopback", () => {
    const decision = evaluateMeshIngress({
      transport: "loopback", method: "GET", pathname: "/v1/guest/whoami", requestTarget: "/v1/guest/whoami",
      headers: {}, destinationKeyId: "x", bootedAt: 0, lookupPeer: () => undefined,
      lookupGuest: () => undefined, nonceClaim: new PeerNonceCache(),
    });
    expect(decision.action).toBe("deny");
  });

  test("a control-tier peer key is not a guest", () => {
    const { peer, evaluate } = gateFixture();
    expect(evaluate({ signer: peer, method: "GET", path: "/v1/guest/whoami" })).toMatchObject({ action: "deny", status: 401 });
  });

  test("guest denials are never softened by verify-warn", () => {
    const { peer, evaluate } = gateFixture();
    const decision = evaluate({ signer: peer, method: "POST", path: "/v1/guest/asks", body: "{}" });
    // Guest routes never flow through applyMeshGateMode; the handler also
    // refuses a request without a gate-attached principal.
    expect(decision.action).toBe("deny");
  });

  test("a guest key is denied on peer and local routes in both gate modes", () => {
    const { guest, evaluate } = gateFixture();
    for (const [method, path] of [
      ["POST", "/v1/mesh/invocations"], ["GET", "/v1/mesh/nodes"], ["POST", "/v1/invocations"], ["GET", "/v1/node"],
    ] as const) {
      for (const transport of ["remote", "loopback"] as const) {
        const decision = evaluate({ signer: guest, method, path, body: method === "POST" ? "{}" : "", transport });
        expect(decision).toMatchObject({ action: "deny", status: 403 });
        for (const mode of ["verify-warn", "enforce"] as const) {
          expect(applyMeshGateMode(decision, { mode, method, pathname: path, logger: quietLogger }).action).toBe("deny");
        }
      }
    }
  });

  test("replay, other-node destination, stale timestamp, tampered path, and revocation are denied", () => {
    const { guest, evaluate, revokeGuest } = gateFixture();
    expect(evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami", nonce: "fixed-nonce" }).action).toBe("allow");
    expect(evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami", nonce: "fixed-nonce" })).toMatchObject({ action: "deny", reason: "nonce replay" });
    expect(evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami", destination: "f".repeat(64) }).action).toBe("deny");
    expect(evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami", ts: Date.now() - 10 * 60_000 }).action).toBe("deny");
    revokeGuest();
    expect(evaluate({ signer: guest, method: "GET", path: "/v1/guest/whoami" }).action).toBe("deny");
  });

  test("the signature covers the body", () => {
    const { guest } = gateFixture();
    const signed = signPeerRequest(guest, { method: "POST", path: "/v1/guest/asks", body: "{\"task\":\"a\"}", destinationKeyId: "d".repeat(64) });
    const decision = evaluateMeshIngress({
      transport: "remote", method: "POST", pathname: "/v1/guest/asks", requestTarget: "/v1/guest/asks",
      headers: headersOf(signed), body: "{\"task\":\"b\"}", destinationKeyId: "d".repeat(64), bootedAt: 0,
      lookupPeer: () => undefined,
      lookupGuest: () => ({ publicKey: guest.publicKey, grantId: "gg_1" }),
      nonceClaim: new PeerNonceCache(),
    });
    expect(decision).toMatchObject({ action: "deny", reason: "invalid signature" });
  });
});

describe("cross-language signing vectors", () => {
  test("TypeScript canonicalization and signatures match the checked-in vectors", () => {
    const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../scout-tailscale/tests/vectors/signing-v1.json"), "utf8")) as {
      privateKeyPkcs8: string; publicKeySpki: string; keyId: string;
      cases: Array<{ method: string; path: string; body: string; destinationKeyId: string; ts: number; nonce: string; bodySha256: string; payload: string; signature: string }>;
    };
    const signer: NodeIdentity = { version: 1, publicKey: vectors.publicKeySpki, privateKey: vectors.privateKeyPkcs8, createdAt: 0 };
    expect(nodeKeyId(signer.publicKey)).toBe(vectors.keyId);
    for (const vector of vectors.cases) {
      expect(sha256Hex(vector.body)).toBe(vector.bodySha256);
      const payload = peerRequestSigningPayload({
        method: vector.method, path: vector.path, bodySha256Hex: vector.bodySha256,
        destinationKeyId: vector.destinationKeyId, ts: vector.ts, nonce: vector.nonce,
      });
      expect(payload).toBe(vector.payload);
      expect(signNodePayload(signer, payload)).toBe(vector.signature);
      expect(verifyNodeSignature(signer.publicKey, payload, vector.signature)).toBe(true);
    }
  });
});

class FakeResponse extends EventEmitter implements RuntimeHttpResponseLike {
  status = 0;
  body = "";
  writableEnded = false;
  destroyed = false;
  writeHead(statusCode: number) { this.status = statusCode; return this; }
  write(chunk: unknown) { this.body += String(chunk); return true; }
  end(chunk?: unknown) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true; return this; }
  get json(): Record<string, unknown> { return JSON.parse(this.body) as Record<string, unknown>; }
}

function fakeRequest(method: string, path: string, body: unknown, context?: RuntimeRequestTransportContext): RuntimeHttpRequestLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method, url: path, headers: { "content-type": "application/json" }, transportContext: context,
  }) as unknown as RuntimeHttpRequestLike;
}

function routeFixture() {
  const grants = store();
  let now = NOW;
  const invocations = new Map<string, InvocationRequest>();
  const flights = new Map<string, FlightRecord>();
  const actors: ActorIdentity[] = [];
  const invoked: InvocationRequest[] = [];
  const posted: MessageRecord[] = [];
  const messages = new Map<string, MessageRecord>();
  const deps: BrokerGuestHttpDeps = {
    grants,
    nodeId: "mini",
    nodeKeyId: "k".repeat(64),
    listAgents: () => [
      { id: "scout.helper", displayName: "Helper" },
      { id: "scout.private", displayName: "Private" },
    ],
    ensureGuestActor: async (actor) => { actors.push(actor); },
    openThread: async ({ requesterId, targetAgentId }) => ({
      id: `dm.${requesterId}.${targetAgentId}`, kind: "direct", title: targetAgentId, visibility: "private",
      shareMode: "local", authorityNodeId: "mini", participantIds: [requesterId, targetAgentId].sort(),
    }),
    postMessage: async (message) => {
      posted.push(message);
      if (!messages.has(message.id)) messages.set(message.id, message);
    },
    invoke: async (invocation) => {
      await Promise.resolve();
      invoked.push(invocation);
      invocations.set(invocation.id, invocation);
      flights.set(invocation.id, { id: `flt-${invoked.length}`, invocationId: invocation.id, requesterId: invocation.requesterId, targetAgentId: invocation.targetAgentId, state: "running" });
      return { accepted: true };
    },
    existingInvocation: (id) => invocations.get(id),
    flightForInvocation: (id) => flights.get(id),
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
  const install = (requestId: string, targets = ["scout.helper"]) =>
    grants.install({ requestId, clientPublicKey: identity().publicKey, label: "Muse", allowedTargets: targets }, now).grant;
  const call = async (method: string, path: string, body?: unknown, context?: RuntimeRequestTransportContext) => {
    const response = new FakeResponse();
    const handled = await handleBrokerGuestRoute(fakeRequest(method, path, body, context), response, new URL(path, "http://x"), method, deps);
    return { handled, response };
  };
  const as = (grant: { id: string; keyId: string }): RuntimeRequestTransportContext =>
    ({ transport: "remote", guest: { grantId: grant.id, keyId: grant.keyId } });
  return { grants, deps, install, call, as, invoked, flights, actors, posted, messages, advance: (ms: number) => { now += ms; } };
}

describe("guest routes", () => {
  test("non-guest paths fall through; guest paths without a gate principal are refused", async () => {
    const { call } = routeFixture();
    expect((await call("GET", "/v1/node")).handled).toBe(false);
    const { response } = await call("GET", "/v1/guest/whoami", undefined, { transport: "loopback" });
    expect(response.status).toBe(401);
  });

  test("whoami and agents derive identity and scope from the grant", async () => {
    const { install, call, as } = routeFixture();
    const grant = install("req-1");
    const who = await call("GET", "/v1/guest/whoami", undefined, as(grant));
    expect(who.response.json).toMatchObject({ protocol: "scout-guest/1", grant: { id: grant.id, actorId: grant.actorId }, node: { id: "mini" } });
    const agents = await call("GET", "/v1/guest/agents", undefined, as(grant));
    expect(agents.response.json).toEqual({ agents: [{ id: "scout.helper", displayName: "Helper" }] });
  });

  test("ask is scoped, deduplicated by client request id, and rejects changed retries", async () => {
    const { install, call, as, invoked, actors } = routeFixture();
    const grant = install("req-1");
    const forbidden = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.private", task: "hi" }, as(grant));
    expect(forbidden.response.status).toBe(403);
    const spoof = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi", requesterId: "operator" }, as(grant));
    expect(spoof.response.status).toBe(400);

    const first = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi" }, as(grant));
    expect(first.response.status).toBe(202);
    expect(first.response.json).toMatchObject({ duplicate: false, invocationId: guestInvocationId(grant.id, "ask-00001"), state: "running" });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ requesterId: grant.actorId, targetAgentId: "scout.helper", task: "hi" });
    expect(actors[0]).toMatchObject({ id: grant.actorId, displayName: "Muse" });

    const retry = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi" }, as(grant));
    expect(retry.response.status).toBe(200);
    expect(retry.response.json).toMatchObject({ duplicate: true });
    expect(invoked).toHaveLength(1);

    const changed = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "different" }, as(grant));
    expect(changed.response.status).toBe(409);
    expect(invoked).toHaveLength(1);
  });

  test("an ask is a message in the guest's thread with the target, so the target can reply to it", async () => {
    const { install, call, as, invoked, messages } = routeFixture();
    const grant = install("req-1");
    await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "critique the spec" }, as(grant));
    const invocationId = guestInvocationId(grant.id, "ask-00001");
    const message = messages.get(guestMessageId(invocationId));
    expect(message).toMatchObject({
      conversationId: `dm.${grant.actorId}.scout.helper`,
      actorId: grant.actorId,
      body: "critique the spec",
      audience: { notify: ["scout.helper"] },
      visibility: "private",
      metadata: { clientMessageId: invocationId, guestGrantId: grant.id },
    });
    expect(invoked[0]).toMatchObject({ id: invocationId, conversationId: message!.conversationId, messageId: message!.id });
  });

  test("identical concurrent submissions post and dispatch once", async () => {
    const { install, call, as, invoked, posted } = routeFixture();
    const grant = install("req-1");
    const body = { requestId: "ask-00001", target: "scout.helper", task: "hi" };
    const results = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/guest/asks", body, as(grant))));
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 200, 202]);
    expect(posted).toHaveLength(1);
    expect(invoked).toHaveLength(1);
  });

  test("a retry after an uncertain acceptance reuses the same thread message and invocation", async () => {
    const { install, call, as, invoked, posted, messages, deps } = routeFixture();
    const grant = install("req-1");
    const accept = deps.invoke;
    deps.invoke = async () => { throw new Error("journal write timed out"); };
    const body = { requestId: "ask-00001", target: "scout.helper", task: "hi" };
    const uncertain = await call("POST", "/v1/guest/asks", body, as(grant));
    expect(uncertain.response.status).toBe(500);
    expect(uncertain.response.json).toMatchObject({ error: "acceptance_uncertain" });
    deps.invoke = accept;
    const retried = await call("POST", "/v1/guest/asks", body, as(grant));
    expect(retried.response.status).toBe(202);
    expect(posted.map((message) => message.id)).toEqual([posted[0]!.id, posted[0]!.id]);
    expect(messages.size).toBe(1);
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ messageId: posted[0]!.id, conversationId: posted[0]!.conversationId });
  });

  for (const end of ["revoke", "expire"] as const) test(`queued retry rechecks ${end} before returning a result`, async () => {
    const { install, call, as, deps, grants, invoked, advance } = routeFixture();
    const grant = install("queued-grant");
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = deps.invoke;
    deps.invoke = async (request) => { entered(); await held; return invoke(request); };
    const body = { requestId: "queued-retry", target: "scout.helper", task: "one task" };
    const first = call("POST", "/v1/guest/asks", body, as(grant));
    await started;
    const second = call("POST", "/v1/guest/asks", body, as(grant));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (end === "revoke") grants.revoke({ grantId: grant.id }, NOW + 1);
    else advance(grant.expiresAt - NOW + 1);
    release();
    await first;
    expect((await second).response.status).toBe(401);
    expect(invoked).toHaveLength(1);
  });

  test("another guest cannot read or collide with an ask", async () => {
    const { install, call, as, invoked } = routeFixture();
    const owner = install("req-1");
    const other = install("req-2");
    await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi" }, as(owner));
    const read = await call("GET", "/v1/guest/asks/ask-00001", undefined, as(other));
    expect(read.response.status).toBe(404);
    const same = await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "other" }, as(other));
    expect(same.response.status).toBe(202);
    expect(invoked.map((invocation) => invocation.id)).toEqual([
      guestInvocationId(owner.id, "ask-00001"),
      guestInvocationId(other.id, "ask-00001"),
    ]);
  });

  test("bounded wait returns the actual reply and ends on revocation", async () => {
    const { install, call, as, flights, grants, deps } = routeFixture();
    const grant = install("req-1");
    await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi" }, as(grant));
    const id = guestInvocationId(grant.id, "ask-00001");
    let ticks = 0;
    deps.sleep = async () => {
      ticks += 1;
      if (ticks === 3) flights.set(id, { ...flights.get(id)!, state: "completed", output: "the answer", completedAt: NOW });
    };
    const done = await call("GET", "/v1/guest/asks/ask-00001?wait=20", undefined, as(grant));
    expect(done.response.json).toMatchObject({ state: "completed", output: "the answer" });

    await call("POST", "/v1/guest/asks", { requestId: "ask-00002", target: "scout.helper", task: "again" }, as(grant));
    deps.sleep = async () => { grants.revoke({ grantId: grant.id }, NOW + 1); };
    const revoked = await call("GET", "/v1/guest/asks/ask-00002?wait=20", undefined, as(grant));
    expect(revoked.response.status).toBe(401);
    const after = await call("GET", "/v1/guest/whoami", undefined, as(grant));
    expect(after.response.status).toBe(401);
  });

  test("wait is capped at 20 seconds", async () => {
    const { install, call, as, deps } = routeFixture();
    const grant = install("req-1");
    await call("POST", "/v1/guest/asks", { requestId: "ask-00001", target: "scout.helper", task: "hi" }, as(grant));
    let waited = 0;
    const baseNow = deps.now!;
    let offset = 0;
    deps.now = () => baseNow() + offset;
    deps.sleep = async (ms) => { waited += ms; offset += ms; };
    const response = await call("GET", "/v1/guest/asks/ask-00001?wait=600", undefined, as(grant));
    expect(response.response.json).toMatchObject({ state: "running" });
    expect(waited).toBeLessThanOrEqual(20_000);
  });

  test("grant administration is local-only and idempotent", async () => {
    const { call } = routeFixture();
    const key = identity().publicKey;
    const body = { requestId: "req-9", clientPublicKey: key, label: "Muse", allowedTargets: ["scout.helper"] };
    const remote = await call("POST", "/v1/guest-grants", body, { transport: "remote" });
    expect(remote.response.status).toBe(403);
    const first = await call("POST", "/v1/guest-grants", body, { transport: "loopback" });
    expect(first.response.json).toMatchObject({ created: true, bootstrap: { protocol: "scout-guest/1", nodeId: "mini" } });
    const again = await call("POST", "/v1/guest-grants", body, { transport: "loopback" });
    expect(again.response.json).toMatchObject({ created: false });
    const revoke = await call("POST", "/v1/guest-grants/revoke", { requestId: "req-9" }, { transport: "loopback" });
    expect(revoke.response.json).toMatchObject({ ok: true, grant: { status: "revoked" } });
  });
});

describe("guest gate at the HTTP server edge", () => {
  test("verify-warn loopback: guest keys are refused off guest routes and verified on them", async () => {
    const { createServer } = await import("node:http");
    const { createMeshIngressGate } = await import("./mesh-ingress-gate.js");
    const node = identity();
    const guest = identity();
    const guestKeyId = nodeKeyId(guest.publicKey);
    const seen: Array<{ path: string; guest?: unknown }> = [];
    const gate = createMeshIngressGate({
      mode: "verify-warn",
      destinationKeyId: nodeKeyId(node.publicKey),
      bootedAt: Date.now() - 60_000,
      lookupPeer: () => undefined,
      lookupGuest: (keyId) => keyId === guestKeyId ? { publicKey: guest.publicKey, grantId: "gg_1" } : undefined,
      nonceClaim: new PeerNonceCache(),
      logger: quietLogger,
    });
    const server = createServer((request, response) => {
      void gate.gateHttpRequest(request, response, (gated) => {
        seen.push({ path: gated.url ?? "", guest: gated.transportContext?.guest });
        response.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const send = async (method: string, path: string, body = "", signer?: NodeIdentity) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (signer) Object.assign(headers, signPeerRequest(signer, { method, path, body, destinationKeyId: nodeKeyId(node.publicKey) }));
      return (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === "GET" ? undefined : body })).status;
    };
    try {
      expect(await send("POST", "/v1/invocations", "{}", guest)).toBe(403);
      expect(await send("GET", "/v1/node", "", guest)).toBe(403);
      expect(await send("POST", "/v1/invocations", "{}")).toBe(200); // unsigned local caller, unchanged
      expect(await send("GET", "/v1/guest/whoami")).toBe(401);
      expect(await send("GET", "/v1/guest/whoami", "", guest)).toBe(200);
      expect(await send("POST", "/v1/guest/asks", "{\"task\":\"x\"}", guest)).toBe(200);
      expect(seen.map((entry) => entry.path)).toEqual(["/v1/invocations", "/v1/guest/whoami", "/v1/guest/asks"]);
      expect(seen[1]?.guest).toEqual({ keyId: guestKeyId, grantId: "gg_1" });
      expect(seen[0]?.guest).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
