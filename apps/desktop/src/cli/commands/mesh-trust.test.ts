import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  TrustEnrollmentService,
  buildSignedNodeCard,
  nodeFingerprint,
  nodeKeyId,
  type NodeIdentity,
  type SignedNodeCard,
} from "@openscout/runtime";

import { ScoutCliError } from "../errors.ts";
import {
  normalizeMeshKeyIdInput,
  parseMeshEnrollArgs,
  parseMeshGrantArgs,
  parseMeshPeerTier,
  parseMeshRevokeArgs,
} from "./mesh-trust.ts";
import {
  beginMeshEnrollment,
  confirmMeshEnrollment,
  normalizeSasWords,
  type MeshTrustFetch,
} from "../../core/mesh/trust-service.ts";

/* ── Parsing ── */

describe("mesh trust argument parsing", () => {
  test("normalizeMeshKeyIdInput accepts full hex key IDs case-insensitively", () => {
    expect(normalizeMeshKeyIdInput("A".repeat(64))).toBe("a".repeat(64));
    expect(normalizeMeshKeyIdInput(`  ${"0f".repeat(32)}  `)).toBe("0f".repeat(32));
  });

  test("normalizeMeshKeyIdInput rejects fingerprints and short hex", () => {
    expect(() => normalizeMeshKeyIdInput("osc1:aaaa-bbbb")).toThrow(ScoutCliError);
    expect(() => normalizeMeshKeyIdInput("a".repeat(16))).toThrow(ScoutCliError);
    expect(() => normalizeMeshKeyIdInput("")).toThrow(ScoutCliError);
  });

  test("parseMeshPeerTier accepts observe and control only", () => {
    expect(parseMeshPeerTier("observe")).toBe("observe");
    expect(parseMeshPeerTier("Control")).toBe("control");
    expect(() => parseMeshPeerTier("admin")).toThrow(ScoutCliError);
    expect(() => parseMeshPeerTier("")).toThrow(ScoutCliError);
  });

  test("parseMeshGrantArgs supports the flag form", () => {
    expect(parseMeshGrantArgs([
      "--key-id", "a".repeat(64),
      "--tier", "control",
      "--label", "air",
    ])).toEqual({ keyId: "a".repeat(64), tier: "control", label: "air" });
  });

  test("parseMeshGrantArgs supports the proposal's positional form and --flag=value", () => {
    expect(parseMeshGrantArgs(["a".repeat(64), "observe"])).toEqual({
      keyId: "a".repeat(64),
      tier: "observe",
    });
    expect(parseMeshGrantArgs([`--key-id=${"b".repeat(64)}`, "--tier=control"])).toEqual({
      keyId: "b".repeat(64),
      tier: "control",
    });
  });

  test("parseMeshGrantArgs requires key ID and tier", () => {
    expect(() => parseMeshGrantArgs([])).toThrow(ScoutCliError);
    expect(() => parseMeshGrantArgs(["--key-id", "a".repeat(64)])).toThrow(ScoutCliError);
    expect(() => parseMeshGrantArgs(["--tier", "observe"])).toThrow(ScoutCliError);
    expect(() => parseMeshGrantArgs(["a".repeat(64), "bogus"])).toThrow(ScoutCliError);
  });

  test("parseMeshRevokeArgs takes a key ID or a fingerprint", () => {
    expect(parseMeshRevokeArgs(["a".repeat(64)])).toEqual({ keyId: "a".repeat(64) });
    expect(parseMeshRevokeArgs(["osc1:aaaa-bbbb"])).toEqual({ fingerprint: "osc1:aaaa-bbbb" });
    expect(() => parseMeshRevokeArgs([])).toThrow(ScoutCliError);
    expect(() => parseMeshRevokeArgs(["a".repeat(64), "extra"])).toThrow(ScoutCliError);
  });

  test("parseMeshEnrollArgs with no args lists local enrollments", () => {
    expect(parseMeshEnrollArgs([])).toEqual({ kind: "list" });
  });

  test("parseMeshEnrollArgs parses the initiator form", () => {
    expect(parseMeshEnrollArgs(["http://peer.test:43110"])).toEqual({
      kind: "begin",
      peerUrl: "http://peer.test:43110",
      tier: "observe",
      yes: false,
    });
    expect(parseMeshEnrollArgs(["peer.test:43110", "--tier", "control", "--yes"])).toEqual({
      kind: "begin",
      peerUrl: "peer.test:43110",
      tier: "control",
      yes: true,
    });
  });

  test("parseMeshEnrollArgs routes ssh:// targets to SSH bootstrap with control default", () => {
    expect(parseMeshEnrollArgs(["ssh://air"])).toEqual({
      kind: "ssh",
      target: "ssh://air",
      tier: "control",
    });
    expect(parseMeshEnrollArgs(["ssh://art@air:2222", "--tier", "observe"])).toEqual({
      kind: "ssh",
      target: "ssh://art@air:2222",
      tier: "observe",
    });
  });

  test("parseMeshEnrollArgs parses --approve and --confirm-sas", () => {
    expect(parseMeshEnrollArgs(["--approve", "enroll-1", "--tier", "control"])).toEqual({
      kind: "approve",
      enrollmentId: "enroll-1",
      tier: "control",
    });
    expect(parseMeshEnrollArgs(["--confirm-sas", "one two three four five six"])).toEqual({
      kind: "confirm",
      words: "one two three four five six",
    });
  });

  test("parseMeshEnrollArgs rejects mixed modes and malformed confirmations", () => {
    expect(() => parseMeshEnrollArgs(["peer.test", "--approve", "x"])).toThrow(ScoutCliError);
    expect(() => parseMeshEnrollArgs(["--confirm-sas", "only three words"])).toThrow(ScoutCliError);
    expect(() => parseMeshEnrollArgs(["--bogus"])).toThrow(ScoutCliError);
  });

  test("normalizeSasWords tolerates dashes, extra spacing, and case", () => {
    expect(normalizeSasWords("  One-Two   three FOUR five\tsix ")).toEqual([
      "one", "two", "three", "four", "five", "six",
    ]);
  });
});

/* ── Enrollment state machine over a stubbed wire ── */

function testIdentity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: Date.now(),
  };
}

function testCard(identity: NodeIdentity, nodeId: string, label: string): SignedNodeCard {
  return buildSignedNodeCard(identity, {
    nodeId,
    label,
    version: "test",
    capabilities: [],
    endpoints: [`http://${nodeId}.test`],
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type StubbedWire = {
  fetchImpl: MeshTrustFetch;
  grantBodies: unknown[];
  responder: TrustEnrollmentService;
  localCard: SignedNodeCard;
  responderCard: SignedNodeCard;
  tamperSas?: (words: string[]) => string[];
};

function stubbedWire(): StubbedWire {
  const localIdentity = testIdentity();
  const responderIdentity = testIdentity();
  const localCard = testCard(localIdentity, "node-local", "local-node");
  const responderCard = testCard(responderIdentity, "node-peer", "peer-node");
  const responder = new TrustEnrollmentService({
    keyId: nodeKeyId(responderIdentity.publicKey),
    publicKey: responderIdentity.publicKey,
    nodeId: "node-peer",
    fingerprint: nodeFingerprint(responderIdentity.publicKey),
  });
  const grantBodies: unknown[] = [];

  const wire: StubbedWire = {
    fetchImpl: (async (url: unknown, init?: { method?: string; body?: string }) => {
      const target = String(url);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (target === "http://broker.test/v1/node") {
        return jsonResponse(200, { card: localCard, gateMode: "verify-warn" });
      }
      if (target === "http://peer.test/v1/trust/enroll/begin") {
        const begun = responder.begin({ card: body.card, commitment: body.commitment });
        return jsonResponse(200, { ...begun, card: responderCard });
      }
      if (target === "http://peer.test/v1/trust/enroll/reveal") {
        const revealed = responder.reveal({
          enrollmentId: body.enrollmentId,
          nonce: body.nonce,
        });
        const words = wire.tamperSas ? wire.tamperSas(revealed.sasWords) : revealed.sasWords;
        return jsonResponse(200, { sasWords: words });
      }
      if (target === "http://broker.test/v1/trust/grant") {
        grantBodies.push(body);
        return jsonResponse(200, { peer: { ...body, grantedVia: "sas", grantedAt: 1 } });
      }
      return jsonResponse(404, { error: "not_found", detail: target });
    }) as MeshTrustFetch,
    grantBodies,
    responder,
    localCard,
    responderCard,
  };
  return wire;
}

describe("mesh enrollment handshake", () => {
  test("begin computes the same SAS words as the responder", async () => {
    const wire = stubbedWire();

    const handshake = await beginMeshEnrollment({
      brokerUrl: "http://broker.test",
      peerUrl: "http://peer.test",
      tier: "control",
      fetchImpl: wire.fetchImpl,
    });

    expect(handshake.enrollmentId).toBeTruthy();
    expect(handshake.words).toHaveLength(6);
    expect(handshake.words).toEqual(wire.responder.list()[0]?.sasWords ?? []);
    expect(handshake.tier).toBe("control");
    expect(handshake.remote.keyId).toBe(wire.responderCard.keyId);
    expect(handshake.local.keyId).toBe(wire.localCard.keyId);
  });

  test("confirm grants the responder's verified card material on the local broker", async () => {
    const wire = stubbedWire();
    const handshake = await beginMeshEnrollment({
      brokerUrl: "http://broker.test",
      peerUrl: "http://peer.test",
      tier: "observe",
      fetchImpl: wire.fetchImpl,
    });

    const peer = await confirmMeshEnrollment(
      "http://broker.test",
      handshake,
      handshake.words.join(" "),
      wire.fetchImpl,
    );

    expect(wire.grantBodies).toEqual([{
      keyId: wire.responderCard.keyId,
      publicKey: wire.responderCard.publicKey,
      fingerprint: wire.responderCard.fingerprint,
      nodeId: "node-peer",
      label: "peer-node",
      tier: "observe",
    }]);
    expect(peer.keyId).toBe(wire.responderCard.keyId);
  });

  test("confirm refuses words that do not match the local SAS", async () => {
    const wire = stubbedWire();
    const handshake = await beginMeshEnrollment({
      brokerUrl: "http://broker.test",
      peerUrl: "http://peer.test",
      tier: "observe",
      fetchImpl: wire.fetchImpl,
    });

    await expect(
      confirmMeshEnrollment(
        "http://broker.test",
        handshake,
        "wrong words do not match the sas",
        wire.fetchImpl,
      ),
    ).rejects.toThrow("do not match");
    expect(wire.grantBodies).toEqual([]);
  });

  test("begin aborts when the peer reports different SAS words", async () => {
    const wire = stubbedWire();
    wire.tamperSas = (words) => [...words.slice(0, 5), "zzz"];

    await expect(
      beginMeshEnrollment({
        brokerUrl: "http://broker.test",
        peerUrl: "http://peer.test",
        tier: "observe",
        fetchImpl: wire.fetchImpl,
      }),
    ).rejects.toThrow("different SAS words");
  });

  test("begin fails clearly when the local broker has no node card", async () => {
    const wire = stubbedWire();
    const fetchImpl = (async (url: unknown) => jsonResponse(200, { gateMode: "verify-warn" })) as MeshTrustFetch;

    await expect(
      beginMeshEnrollment({
        brokerUrl: "http://broker.test",
        peerUrl: "http://peer.test",
        tier: "observe",
        fetchImpl,
      }),
    ).rejects.toThrow("node card");
    expect(wire.grantBodies).toEqual([]);
  });
});
