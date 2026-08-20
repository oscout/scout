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
