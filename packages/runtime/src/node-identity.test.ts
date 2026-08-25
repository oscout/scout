import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildSignedNodeCard,
  canonicalJson,
  loadOrCreateNodeIdentity,
  loadOrCreateStableNodeQualifier,
  nodeFingerprint,
  nodeKeyId,
  readStableNodeQualifier,
  resolveStableLocalNodeId,
  signNodePayload,
  verifyNodeSignature,
  verifySignedNodeCard,
} from "./node-identity.js";

function tempSupportDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openscout-node-identity-test-"));
}

describe("node identity", () => {
  test("creates and persists an Ed25519 identity with restrictive permissions", () => {
    const dir = tempSupportDirectory();
    const identity = loadOrCreateNodeIdentity(dir);
    expect(identity.version).toBe(1);
    expect(identity.publicKey.length).toBeGreaterThan(0);
    expect(identity.privateKey.length).toBeGreaterThan(0);

    const mode = statSync(join(dir, "node-identity.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    const reloaded = loadOrCreateNodeIdentity(dir);
    expect(reloaded.publicKey).toBe(identity.publicKey);
    expect(reloaded.privateKey).toBe(identity.privateKey);
  });

  test("fingerprint is stable, prefixed, and derived from the public key", () => {
    const dir = tempSupportDirectory();
    const identity = loadOrCreateNodeIdentity(dir);
    const fingerprint = nodeFingerprint(identity.publicKey);
    expect(fingerprint).toMatch(/^osc1:[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(nodeFingerprint(identity.publicKey)).toBe(fingerprint);

    const other = loadOrCreateNodeIdentity(tempSupportDirectory());
    expect(nodeFingerprint(other.publicKey)).not.toBe(fingerprint);
  });

  test("keeps legitimate numeric hostnames as distinct key-backed identities", () => {
    const pi4 = tempSupportDirectory();
    const pi5 = tempSupportDirectory();

    expect(loadOrCreateStableNodeQualifier("pi-4.local", pi4)).toBe("pi-4-local");
    expect(loadOrCreateStableNodeQualifier("pi-5.local", pi5)).toBe("pi-5-local");
    expect(resolveStableLocalNodeId({
      nodeName: "pi-4.local",
      meshId: "openscout",
      supportDirectory: pi4,
    })).toBe("pi-4-local-openscout");
    expect(resolveStableLocalNodeId({
      nodeName: "pi-5.local",
      meshId: "openscout",
      supportDirectory: pi5,
    })).toBe("pi-5-local-openscout");
    expect(loadOrCreateNodeIdentity(pi4).publicKey)
      .not.toBe(loadOrCreateNodeIdentity(pi5).publicKey);
  });

  test("persists routing authority across hostname collision suffix drift", () => {
    const dir = tempSupportDirectory();

    expect(loadOrCreateStableNodeQualifier("Test-Workstation-372.local", dir))
      .toBe("test-workstation-372-local");
    expect(loadOrCreateStableNodeQualifier("Test-Workstation-419.local", dir))
      .toBe("test-workstation-372-local");
    expect(readStableNodeQualifier(dir)).toBe("test-workstation-372-local");

    expect(resolveStableLocalNodeId({
      nodeName: "Test-Workstation-476.local",
      meshId: "openscout",
      supportDirectory: dir,
    })).toBe("test-workstation-372-local-openscout");
  });

  test("an explicit node id still overrides persisted default authority", () => {
    const dir = tempSupportDirectory();
    expect(resolveStableLocalNodeId({
      configuredNodeId: "operator-pinned-node",
      nodeName: "Test-Workstation-476.local",
      meshId: "openscout",
      supportDirectory: dir,
    })).toBe("operator-pinned-node");
    expect(readStableNodeQualifier(dir)).toBe("test-workstation-476-local");
  });

  test("signs and verifies payloads; rejects wrong keys and tampering", () => {
    const identity = loadOrCreateNodeIdentity(tempSupportDirectory());
    const other = loadOrCreateNodeIdentity(tempSupportDirectory());

    const signature = signNodePayload(identity, "hello mesh");
    expect(verifyNodeSignature(identity.publicKey, "hello mesh", signature)).toBe(true);
    expect(verifyNodeSignature(identity.publicKey, "hello mesh!", signature)).toBe(false);
    expect(verifyNodeSignature(other.publicKey, "hello mesh", signature)).toBe(false);
    expect(verifyNodeSignature(identity.publicKey, "hello mesh", "not-base64!!")).toBe(false);
  });

  test("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  test("signed node cards verify and detect tampering", () => {
    const identity = loadOrCreateNodeIdentity(tempSupportDirectory());
    const card = buildSignedNodeCard(identity, {
      nodeId: "test-workstation-local-openscout",
      label: "Test Workstation",
      version: "0.9.0",
      capabilities: ["control", "observe"],
      endpoints: ["http://192.168.18.9:43110"],
    });

    expect(card.fingerprint).toBe(nodeFingerprint(identity.publicKey));
    expect(card.keyId).toBe(nodeKeyId(identity.publicKey));
    expect(card.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(card.capabilities).toEqual(["control", "observe"]);
    expect(card.expiresAt).toBeGreaterThan(card.issuedAt);
    expect(verifySignedNodeCard(card)).toBe(true);

    expect(verifySignedNodeCard({ ...card, label: "Evil Mini" })).toBe(false);
    expect(verifySignedNodeCard({ ...card, endpoints: ["http://10.0.0.99:43110"] })).toBe(false);
    expect(verifySignedNodeCard({ ...card, keyId: nodeKeyId(loadOrCreateNodeIdentity(tempSupportDirectory()).publicKey) })).toBe(false);

    const other = loadOrCreateNodeIdentity(tempSupportDirectory());
    expect(verifySignedNodeCard({ ...card, publicKey: other.publicKey })).toBe(false);
  });

  test("cards with a tls attestation round-trip; malformed tls is rejected (§11.2)", () => {
    const identity = loadOrCreateNodeIdentity(tempSupportDirectory());
    const pin = "a".repeat(64);
    const card = buildSignedNodeCard(identity, {
      nodeId: "tls-node",
      label: "TLS Node",
      version: "0.9.0",
      capabilities: ["observe"],
      endpoints: ["https://192.168.18.9:43111"],
      tls: { spkiFingerprint: pin },
    });
    expect(card.tls).toEqual({ spkiFingerprint: pin });
    expect(verifySignedNodeCard(card)).toBe(true);

    // The tls field is signed: tampering with the pin fails verification.
    expect(verifySignedNodeCard({ ...card, tls: { spkiFingerprint: "b".repeat(64) } })).toBe(false);

    // Runtime validation of the pin shape — a pin is only ever stored from a
    // well-formed, signature-valid card.
    expect(verifySignedNodeCard({ ...card, tls: { spkiFingerprint: "A".repeat(64) } })).toBe(false);
    expect(verifySignedNodeCard({ ...card, tls: { spkiFingerprint: "abc" } })).toBe(false);
    expect(verifySignedNodeCard({ ...card, tls: { spkiFingerprint: "g".repeat(64) } })).toBe(false);
    expect(verifySignedNodeCard({ ...card, tls: {} as never })).toBe(false);
    expect(verifySignedNodeCard({ ...card, tls: null as never })).toBe(false);
  });

  test("cross-version cards verify both directions (§11.2)", () => {
    const identity = loadOrCreateNodeIdentity(tempSupportDirectory());
    const fields = {
      nodeId: "versioned-node",
      label: "Versioned",
      version: "0.9.0",
      capabilities: ["observe"],
      endpoints: ["http://192.168.18.9:43110"],
    };

    // P1.5 code verifies a P1 (tls-absent) card.
    const p1Card = buildSignedNodeCard(identity, fields);
    expect(p1Card.tls).toBeUndefined();
    expect(verifySignedNodeCard(p1Card)).toBe(true);

    // A P1 verifier — which recomputes canonicalJson over ALL present fields —
    // accepts a P1.5 (tls-present) card: the extra field is simply hashed.
    const p15Card = buildSignedNodeCard(identity, { ...fields, tls: { spkiFingerprint: "c".repeat(64) } });
    const { signature, ...unsigned } = p15Card;
    expect(verifyNodeSignature(p15Card.publicKey, canonicalJson(unsigned), signature)).toBe(true);
    expect(verifySignedNodeCard(p15Card)).toBe(true);
  });

  test("expired cards are rejected", () => {
    const identity = loadOrCreateNodeIdentity(tempSupportDirectory());
    const issuedAt = Date.now() - 48 * 60 * 60 * 1_000;
    const card = buildSignedNodeCard(identity, {
      nodeId: "old-node",
      label: "Old",
      version: "0.9.0",
      capabilities: ["observe"],
      endpoints: [],
    }, issuedAt);
    expect(verifySignedNodeCard(card)).toBe(false);
    expect(verifySignedNodeCard(card, issuedAt + 1_000)).toBe(true);
  });

  test("refuses a corrupt identity file", () => {
    const dir = tempSupportDirectory();
    writeFileSync(join(dir, "node-identity.json"), '{"version":2}\n', "utf8");
    expect(() => loadOrCreateNodeIdentity(dir)).toThrow(/Corrupt node identity/);
  });

  test("stored file is JSON with no plaintext key material beyond the identity", () => {
    const dir = tempSupportDirectory();
    const identity = loadOrCreateNodeIdentity(dir);
    const stored = JSON.parse(readFileSync(join(dir, "node-identity.json"), "utf8"));
    expect(stored.publicKey).toBe(identity.publicKey);
    expect(Object.keys(stored).sort()).toEqual(["createdAt", "privateKey", "publicKey", "version"]);
  });
});
