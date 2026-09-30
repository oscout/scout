import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  nodeKeyId,
  type NodeIdentity,
} from "./node-identity.js";
import {
  PEER_AUTH_HEADERS,
  PeerNonceCache,
  signPeerRequest,
  type PeerAuthLookup,
  type PeerRequestHeaders,
} from "./mesh-peer-auth.js";
import {
  applyMeshGateMode,
  classifyMeshTransport,
  DenialThrottle,
  evaluateMeshIngress,
  type MeshIngressDecision,
} from "./mesh-ingress-gate.js";
import type { MeshPeerTier } from "./mesh-peer-auth.js";

/**
 * Unit-level gate coverage (docs/proposals/mesh-trust-cone.md §10 acceptance
 * tests): transport classification, deny-by-default, signature/grant/tier
 * checks, replay and timestamp rejection, and the verify-warn rollout mode.
 * Store methods are faked here; the real SQLite implementations are covered
 * by trusted-peers.test.ts and peer-nonces.test.ts.
 */

function testIdentity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: Date.now(),
  };
}

function toPeerHeaders(signed: Record<string, string>): PeerRequestHeaders {
  return {
    peer: signed[PEER_AUTH_HEADERS.peer],
    ts: signed[PEER_AUTH_HEADERS.ts],
    nonce: signed[PEER_AUTH_HEADERS.nonce],
    signature: signed[PEER_AUTH_HEADERS.signature],
  };
}

function fixture() {
  const destination = testIdentity();
  const destinationKeyId = nodeKeyId(destination.publicKey);
  const peer = testIdentity();
  const peerKeyId = nodeKeyId(peer.publicKey);
  const peers = new Map<string, { publicKey: string; tier: MeshPeerTier }>();
  const enroll = (tier: MeshPeerTier) => peers.set(peerKeyId, { publicKey: peer.publicKey, tier });
  enroll("observe");
  const lookupPeer: PeerAuthLookup = (keyId) => peers.get(keyId);
  const nonceClaim = new PeerNonceCache();
  const bootedAt = Date.now() - 60_000;

  const signedHeaders = (input: {
    method: string;
    path: string;
    body?: string;
    ts?: number;
    nonce?: string;
    destinationKeyId?: string;
  }): PeerRequestHeaders =>
    toPeerHeaders(signPeerRequest(peer, {
      method: input.method,
      path: input.path,
      body: input.body,
      destinationKeyId: input.destinationKeyId ?? destinationKeyId,
      ts: input.ts,
      nonce: input.nonce,
    }));

  const evaluate = (input: {
    transport: "unix-socket" | "loopback" | "remote";
    method: string;
    pathname: string;
    requestTarget?: string;
    headers?: PeerRequestHeaders;
    body?: string;
  }): MeshIngressDecision =>
    evaluateMeshIngress({
      transport: input.transport,
      method: input.method,
      pathname: input.pathname,
      requestTarget: input.requestTarget ?? input.pathname,
      headers: input.headers ?? {},
      body: input.body,
      destinationKeyId,
      bootedAt,
      lookupPeer,
      nonceClaim,
    });

  return { destination, destinationKeyId, peer, peerKeyId, peers, enroll, signedHeaders, evaluate };
}

describe("classifyMeshTransport", () => {
  test("classifies unix sockets, loopback, and remote addresses", () => {
    expect(classifyMeshTransport(undefined)).toBe("unix-socket");
    expect(classifyMeshTransport(null)).toBe("unix-socket");
    expect(classifyMeshTransport("127.0.0.1")).toBe("loopback");
    expect(classifyMeshTransport("::1")).toBe("loopback");
    expect(classifyMeshTransport("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyMeshTransport("10.0.0.8")).toBe("remote");
    expect(classifyMeshTransport("192.168.1.20")).toBe("remote");
    // loopback lookalikes are not loopback
    expect(classifyMeshTransport("127.0.0.2")).toBe("remote");
  });
});

describe("evaluateMeshIngress", () => {
  test("loopback and unix-socket pass unauthenticated, even on local routes", () => {
    const { evaluate } = fixture();
    for (const transport of ["loopback", "unix-socket"] as const) {
      const decision = evaluate({ transport, method: "POST", pathname: "/v1/commands" });
      expect(decision.action).toBe("allow");
    }
  });

  test("remote public routes pass unauthenticated", () => {
    const { evaluate } = fixture();
    expect(evaluate({ transport: "remote", method: "GET", pathname: "/v1/node" }).action).toBe("allow");
    expect(evaluate({ transport: "remote", method: "POST", pathname: "/v1/trust/enroll/begin" }).action).toBe("allow");
    expect(evaluate({ transport: "remote", method: "POST", pathname: "/v1/trust/enroll/reveal" }).action).toBe("allow");
  });

  test("remote unsigned requests to local-tier routes are denied", () => {
    const { evaluate } = fixture();
    const decision = evaluate({ transport: "remote", method: "POST", pathname: "/v1/commands" });
    expect(decision).toEqual({ action: "deny", status: 403, reason: "route is local-only" });
  });

  test("remote unsigned requests to observe/control routes are denied as unauthenticated", () => {
    const { evaluate } = fixture();
    const observe = evaluate({ transport: "remote", method: "GET", pathname: "/v1/mesh/nodes" });
    expect(observe).toEqual({ action: "deny", status: 401, reason: "missing peer auth headers" });
    const control = evaluate({ transport: "remote", method: "POST", pathname: "/v1/mesh/messages", body: "{}" });
    expect(control).toEqual({ action: "deny", status: 401, reason: "missing peer auth headers" });
    // the /trpc WS upgrade tier behaves the same way
    const upgrade = evaluate({ transport: "remote", method: "GET", pathname: "/trpc" });
    expect(upgrade).toEqual({ action: "deny", status: 401, reason: "missing peer auth headers" });
  });

  test("unknown routes from remote peers fall back to local (deny by default)", () => {
    const { evaluate } = fixture();
    const decision = evaluate({ transport: "remote", method: "GET", pathname: "/v1/unmapped" });
    expect(decision).toEqual({ action: "deny", status: 403, reason: "route is local-only" });
  });

  test("remote with a valid signature and observe grant passes observe routes", () => {
    const { evaluate, signedHeaders, peerKeyId } = fixture();
    const path = "/v1/mesh/nodes?limit=5";
    const decision = evaluate({
      transport: "remote",
      method: "GET",
      pathname: "/v1/mesh/nodes",
      requestTarget: path,
      headers: signedHeaders({ method: "GET", path }),
    });
    expect(decision.action).toBe("allow");
    expect(decision.action === "allow" && decision.principal).toEqual({ keyId: peerKeyId, tier: "observe" });
  });

  test("control routes reject an observe-tier grant, accept a control grant", () => {
    const { evaluate, signedHeaders, enroll } = fixture();
    const path = "/v1/mesh/messages";
    const attempt = () =>
      evaluate({
        transport: "remote",
        method: "POST",
        pathname: path,
        headers: signedHeaders({ method: "POST", path, body: "{\"hello\":1}" }),
        body: "{\"hello\":1}",
      });

    const denied = attempt();
    expect(denied.action).toBe("deny");
    expect(denied.action === "deny" && denied.status).toBe(403);
    expect(denied.action === "deny" && denied.reason).toContain("observe");
    expect(denied.action === "deny" && denied.reason).toContain("control");

    enroll("control");
    const allowed = attempt();
    expect(allowed.action).toBe("allow");
    expect(allowed.action === "allow" && allowed.principal?.tier).toBe("control");
  });

  test("replayed nonces are rejected", () => {
    const { evaluate, signedHeaders } = fixture();
    const path = "/v1/mesh/nodes";
    const headers = signedHeaders({ method: "GET", path });
    const first = evaluate({ transport: "remote", method: "GET", pathname: path, headers });
    expect(first.action).toBe("allow");
    const replay = evaluate({ transport: "remote", method: "GET", pathname: path, headers });
    expect(replay).toEqual({ action: "deny", status: 401, reason: "nonce replay" });
  });

  test("unenrolled (unknown/revoked/expired) peers are rejected", () => {
    const { evaluate, signedHeaders, peers } = fixture();
    peers.clear(); // revoked/expired peers drop out of the lookup, same as unknown
    const path = "/v1/mesh/nodes";
    const decision = evaluate({
      transport: "remote",
      method: "GET",
      pathname: path,
      headers: signedHeaders({ method: "GET", path }),
    });
    expect(decision.action).toBe("deny");
    expect(decision.action === "deny" && decision.status).toBe(401);
    expect(decision.action === "deny" && decision.reason).toContain("not enrolled");
  });

  test("skewed and pre-boot timestamps are rejected", () => {
    const { evaluate, signedHeaders } = fixture();
    const path = "/v1/mesh/nodes";

    const skewed = evaluate({
      transport: "remote",
      method: "GET",
      pathname: path,
      headers: signedHeaders({ method: "GET", path, ts: Date.now() + 6 * 60_000 }),
    });
    expect(skewed).toEqual({ action: "deny", status: 401, reason: "timestamp outside acceptable skew" });

    // within the skew window but before broker boot (minus the 15s grace):
    // closes the restart replay hole left by the volatile nonce cache
    const freshFixture = fixture();
    const preBoot = evaluateMeshIngress({
      transport: "remote",
      method: "GET",
      pathname: path,
      requestTarget: path,
      headers: freshFixture.signedHeaders({ method: "GET", path, ts: Date.now() - 20_000 }),
      destinationKeyId: freshFixture.destinationKeyId,
      bootedAt: Date.now(),
      lookupPeer: (keyId) => freshFixture.peers.get(keyId),
      nonceClaim: new PeerNonceCache(),
    });
    expect(preBoot).toEqual({ action: "deny", status: 401, reason: "timestamp predates broker boot" });
  });

  test("requests signed for a different destination node are rejected", () => {
    const { evaluate, signedHeaders } = fixture();
    const otherNode = testIdentity();
    const path = "/v1/mesh/nodes";
    const decision = evaluate({
      transport: "remote",
      method: "GET",
      pathname: path,
      headers: signedHeaders({ method: "GET", path, destinationKeyId: nodeKeyId(otherNode.publicKey) }),
    });
    expect(decision).toEqual({ action: "deny", status: 401, reason: "invalid signature" });
  });

  test("body tampering breaks the signature", () => {
    const { evaluate, signedHeaders, enroll } = fixture();
    enroll("control");
    const path = "/v1/mesh/messages";
    const decision = evaluate({
      transport: "remote",
      method: "POST",
      pathname: path,
      headers: signedHeaders({ method: "POST", path, body: "{\"a\":1}" }),
      body: "{\"a\":2}",
    });
    expect(decision).toEqual({ action: "deny", status: 401, reason: "invalid signature" });
  });

  test("path tampering breaks the signature", () => {
    const { evaluate, signedHeaders } = fixture();
    const decision = evaluate({
      transport: "remote",
      method: "GET",
      pathname: "/v1/mesh/nodes",
      requestTarget: "/v1/mesh/nodes?limit=99",
      headers: signedHeaders({ method: "GET", path: "/v1/mesh/nodes?limit=1" }),
    });
    expect(decision).toEqual({ action: "deny", status: 401, reason: "invalid signature" });
  });
});

describe("applyMeshGateMode", () => {
  const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "missing peer auth headers" };

  test("verify-warn logs the failure (keyId/route/reason) but allows", () => {
    const warnings: string[] = [];
    const decision = applyMeshGateMode(deny, {
      mode: "verify-warn",
      method: "GET",
      pathname: "/v1/mesh/nodes",
      keyId: "abc123",
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(decision.action).toBe("allow");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("GET /v1/mesh/nodes");
    expect(warnings[0]).toContain("abc123");
    expect(warnings[0]).toContain("missing peer auth headers");
    expect(warnings[0]).toContain("verify-warn");
  });

  test("enforce logs and keeps the deny", () => {
    const warnings: string[] = [];
    const decision = applyMeshGateMode(deny, {
      mode: "enforce",
      method: "POST",
      pathname: "/v1/commands",
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(decision).toEqual(deny);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("enforce");
  });

  test("allow decisions pass through silently in both modes", () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    for (const mode of ["verify-warn", "enforce"] as const) {
      const decision = applyMeshGateMode(
        { action: "allow", principal: { keyId: "k", tier: "observe" } },
        { mode, method: "GET", pathname: "/v1/mesh/nodes", logger },
      );
      expect(decision.action).toBe("allow");
    }
    expect(warnings).toEqual([]);
  });
});

describe("DenialThrottle", () => {
  test("logs the first denial, suppresses repeats, then rolls up the count per interval", () => {
    let now = 1_000;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "unknown peer" };
    const context = {
      mode: "enforce" as const,
      method: "GET",
      pathname: "/v1/mesh/nodes",
      keyId: "peer-k",
      logger,
      throttle,
    };

    // First denial emits immediately; the next three in the window are
    // counted silently.
    applyMeshGateMode(deny, context);
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      const decision = applyMeshGateMode(deny, context);
      expect(decision).toEqual(deny);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("denied GET /v1/mesh/nodes peer=peer-k — unknown peer");
    expect(warnings[0]).not.toContain("suppressed");

    // The first denial past the interval emits once, carrying the count of
    // the three suppressed repeats.
    now += 60_000;
    applyMeshGateMode(deny, context);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("(+3 suppressed since last log)");

    // A different signature is its own bucket and still logs immediately.
    now += 1;
    applyMeshGateMode(deny, { ...context, keyId: "peer-other" });
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toContain("peer=peer-other");
    expect(warnings[2]).not.toContain("suppressed");
  });

  test("verify-warn denials are throttled the same way", () => {
    let now = 0;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const context = {
      mode: "verify-warn" as const,
      method: "GET",
      pathname: "/v1/x",
      keyId: "k",
      logger: { warn: (message: string) => warnings.push(message) },
      throttle,
    };
    const deny: MeshIngressDecision = { action: "deny", status: 403, reason: "route is local-only" };
    expect(applyMeshGateMode(deny, context).action).toBe("allow");
    expect(applyMeshGateMode(deny, context).action).toBe("allow");
    expect(warnings).toHaveLength(1);
    now += 61_000;
    applyMeshGateMode(deny, context);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("verify-warn");
    expect(warnings[1]).toContain("(+1 suppressed since last log)");
  });

  test("a flood of distinct signatures stays bounded — capped buckets, capped lines, one rollup per window", () => {
    let now = 1_000;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "unknown peer" };
    const contextFor = (keyId: string) => ({
      mode: "enforce" as const,
      method: "GET",
      pathname: "/v1/mesh/nodes",
      keyId,
      logger,
      throttle,
    });

    for (let i = 0; i < 100_000; i += 1) {
      applyMeshGateMode(deny, contextFor(`peer-${i}`));
    }

    // Bounded storage and bounded lines: 20 first-seen lines, everything else
    // counted silently for the window rollup.
    expect(throttle.size).toBe(512);
    expect(warnings).toHaveLength(20);

    // The first denial of the next window reports the overflow once.
    now += 60_000;
    applyMeshGateMode(deny, contextFor("peer-rollover"));
    expect(warnings).toHaveLength(22);
    expect(warnings[20]).toContain("… and 99980 more distinct denial signatures suppressed");
    expect(warnings[21]).toContain("peer=peer-rollover");
  });

  test("recurring emissions share the per-window allowance — 512 repeats emit 20 lines plus one rollup", () => {
    let now = 1_000;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "unknown peer" };
    const contextFor = (keyId: string) => ({
      mode: "enforce" as const,
      method: "GET",
      pathname: "/v1/mesh/nodes",
      keyId,
      logger,
      throttle,
    });

    // 512 distinct signatures at t=0: 20 first-seen lines, 492 overflow.
    const peers = Array.from({ length: 512 }, (_, i) => `peer-${i}`);
    for (const keyId of peers) {
      applyMeshGateMode(deny, contextFor(keyId));
    }
    expect(warnings).toHaveLength(20);

    // One window later every signature repeats. First-seen and recurring
    // emissions share the 20-line allowance, so the batch emits 20 signature
    // lines plus a single rollup — not one line per signature (513).
    warnings.length = 0;
    now += 60_000;
    for (const keyId of peers) {
      applyMeshGateMode(deny, contextFor(keyId));
    }
    const aggregates = warnings.filter((message) => message.includes("more distinct denial signatures"));
    const signatureLines = warnings.filter((message) => !message.includes("more distinct denial signatures"));
    expect(signatureLines).toHaveLength(20);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toContain("… and 492 more distinct denial signatures suppressed");
  });

  test("id-like route segments and oversized key ids normalize into one signature", () => {
    const now = 1_000;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "unknown peer" };

    // Distinct concrete ids collapse onto one bucket; the second denial is
    // suppressed as a repeat of the first.
    applyMeshGateMode(deny, {
      mode: "enforce", method: "GET", pathname: "/v1/agents/3f8a2c1e-9b4d-4e6f-8a0b-1c2d3e4f5a6b/messages", keyId: "k", logger, throttle,
    });
    applyMeshGateMode(deny, {
      mode: "enforce", method: "GET", pathname: "/v1/agents/77aa10ff-2211-4c33-9d44-556677889900/messages", keyId: "k", logger, throttle,
    });
    expect(warnings).toHaveLength(1);
    expect(throttle.size).toBe(1);

    // Two keyIds sharing a 64-char prefix are the same signature.
    const prefix = "k".repeat(64);
    applyMeshGateMode(deny, {
      mode: "enforce", method: "GET", pathname: "/v1/other", keyId: `${prefix}-a`, logger, throttle,
    });
    applyMeshGateMode(deny, {
      mode: "enforce", method: "GET", pathname: "/v1/other", keyId: `${prefix}-b`, logger, throttle,
    });
    expect(warnings).toHaveLength(2);
    expect(throttle.size).toBe(2);
  });

  test("expired buckets are swept on insert and a stale signature emits fresh", () => {
    let now = 1_000;
    const throttle = new DenialThrottle(60_000, () => now);
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const deny: MeshIngressDecision = { action: "deny", status: 401, reason: "unknown peer" };
    const contextFor = (keyId: string) => ({
      mode: "enforce" as const, method: "GET", pathname: "/v1/mesh/nodes", keyId, logger, throttle,
    });

    for (let i = 0; i < 512; i += 1) {
      applyMeshGateMode(deny, contextFor(`peer-${i}`));
    }
    expect(throttle.size).toBe(512);

    // Past the 5-minute expiry every bucket is stale; the next inserts sweep
    // them instead of evicting live entries or growing past the cap.
    now += 5 * 60_000 + 1;
    applyMeshGateMode(deny, contextFor("peer-0"));
    applyMeshGateMode(deny, contextFor("peer-fresh"));
    expect(throttle.size).toBe(2);
    // peer-0 emitted again as first-seen (its suppressed history expired with
    // the bucket) — the aggregate rollup reports the swept window's overflow.
    const peer0Lines = warnings.filter((message) => message.includes("peer=peer-0"));
    expect(peer0Lines).toHaveLength(2);
    expect(peer0Lines[1]).not.toContain("suppressed since last log");
  });
});
