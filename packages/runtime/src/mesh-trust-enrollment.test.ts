import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  buildSignedNodeCard,
  loadOrCreateNodeIdentity,
  nodeFingerprint,
  nodeKeyId,
} from "./node-identity.js";
import {
  computeEnrollmentSas,
  createEnrollmentCommitment,
  formatSas,
  verifyEnrollmentCommitment,
} from "./mesh-sas.js";
import {
  TrustEnrollmentError,
  TrustEnrollmentService,
  TrustEndpointRateLimiter,
} from "./mesh-trust-enrollment.js";

function freshIdentity() {
  return loadOrCreateNodeIdentity(mkdtempSync(join(tmpdir(), "openscout-enroll-test-")));
}

function cardFor(identity: ReturnType<typeof freshIdentity>, label: string) {
  return buildSignedNodeCard(identity, {
    nodeId: `${label}-node`,
    label,
    version: "0.9.0",
    capabilities: ["observe"],
    endpoints: ["http://192.168.18.10:43110"],
  });
}

describe("enrollment SAS", () => {
  test("commitment verifies and rejects tampering", () => {
    const nonce = randomBytes(32);
    const commitment = createEnrollmentCommitment(nonce, "sig-abc");
    expect(verifyEnrollmentCommitment(commitment, nonce, "sig-abc")).toBe(true);
    expect(verifyEnrollmentCommitment(commitment, randomBytes(32), "sig-abc")).toBe(false);
    expect(verifyEnrollmentCommitment(commitment, nonce, "sig-other")).toBe(false);
  });

  test("both sides compute the same six words regardless of order", () => {
    const input = {
      challengeId: "ch-1",
      keyIdA: "a".repeat(64),
      keyIdB: "b".repeat(64),
      publicKeyA: "pk-a",
      publicKeyB: "pk-b",
      nodeIdA: "node-a",
      nodeIdB: "node-b",
      nonceA: randomBytes(32),
      nonceB: randomBytes(32),
    };
    const one = computeEnrollmentSas(input);
    const two = computeEnrollmentSas({
      ...input,
      keyIdA: input.keyIdB,
      keyIdB: input.keyIdA,
      publicKeyA: input.publicKeyB,
      publicKeyB: input.publicKeyA,
      nodeIdA: input.nodeIdB,
      nodeIdB: input.nodeIdA,
      nonceA: input.nonceB,
      nonceB: input.nonceA,
    });
    expect(one).toEqual(two);
    expect(one).toHaveLength(6);
    // The EFF list includes compound entries such as "yo-yo", so validate
    // word shape before joining rather than counting separator hyphens.
    for (const word of one) expect(word).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(formatSas(one)).toBe(one.join("-"));
  });

  test("transcript changes produce different codes", () => {
    const base = {
      challengeId: "ch-1",
      keyIdA: "a".repeat(64),
      keyIdB: "b".repeat(64),
      publicKeyA: "pk-a",
      publicKeyB: "pk-b",
      nodeIdA: "node-a",
      nodeIdB: "node-b",
      nonceA: randomBytes(32),
      nonceB: randomBytes(32),
    };
    const one = computeEnrollmentSas(base);
    expect(computeEnrollmentSas({ ...base, challengeId: "ch-2" })).not.toEqual(one);
    expect(computeEnrollmentSas({ ...base, nonceA: randomBytes(32) })).not.toEqual(one);
    expect(computeEnrollmentSas({ ...base, nodeIdB: "node-c" })).not.toEqual(one);
  });
});

describe("trust enrollment service", () => {
  function setup() {
    const initiator = freshIdentity();
    const responder = freshIdentity();
    const service = new TrustEnrollmentService({
      keyId: nodeKeyId(responder.publicKey),
      publicKey: responder.publicKey,
      nodeId: "responder-node",
      fingerprint: nodeFingerprint(responder.publicKey),
    });
    const initiatorCard = cardFor(initiator, "air");
    const responderCard = cardFor(responder, "responder");
    const initiatorNonce = randomBytes(32);
    const commitment = createEnrollmentCommitment(initiatorNonce, initiatorCard.signature);
    return { responder, service, initiatorCard, responderCard, initiatorNonce, commitment };
  }

  test("happy path: begin → reveal → approve yields a grant keyed by key ID", () => {
    const { service, responderCard, initiatorCard, initiatorNonce, commitment } = setup();

    const { enrollmentId, responderNonce } = service.begin({ card: initiatorCard, commitment });
    expect(service.status(enrollmentId)).toBe("pending");

    const { sasWords } = service.reveal({ enrollmentId, nonce: initiatorNonce.toString("base64") });
    expect(service.status(enrollmentId)).toBe("ready");

    const initiatorWords = TrustEnrollmentService.initiatorSas({
      challengeId: enrollmentId,
      ownCard: initiatorCard,
      ownNonce: initiatorNonce,
      responderCard,
      responderNonce: Buffer.from(responderNonce, "base64"),
    });
    expect(initiatorWords).toEqual(sasWords);

    const grant = service.approve({ enrollmentId, tier: "control" });
    expect(grant.keyId).toBe(initiatorCard.keyId);
    expect(grant.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.fingerprint).toBe(initiatorCard.fingerprint);
    expect(grant.publicKey).toBe(initiatorCard.publicKey);
    expect(grant.label).toBe("air");
    expect(grant.tier).toBe("control");
    expect(grant.grantedVia).toBe("sas");
    expect(service.status(enrollmentId)).toBe("approved");
  });

  test("rejects an invalid card, self-enrollment, and commitment mismatch", () => {
    const { service, responder, initiatorCard, commitment } = setup();

    expect(() => service.begin({
      card: { ...initiatorCard, label: "Forged" },
      commitment,
    })).toThrow(TrustEnrollmentError);

    const selfCard = cardFor(responder, "self");
    expect(() => service.begin({
      card: selfCard,
      commitment: createEnrollmentCommitment(randomBytes(32), selfCard.signature),
    })).toThrow(/self/);

    const { enrollmentId } = service.begin({ card: initiatorCard, commitment });
    expect(() => service.reveal({ enrollmentId, nonce: randomBytes(32).toString("base64") }))
      .toThrow(/does not match commitment/);
  });

  test("approve requires the ready state; enrollments expire", () => {
    const { service, initiatorCard, initiatorNonce, commitment } = setup();
    const now = Date.now();

    const { enrollmentId } = service.begin({ card: initiatorCard, commitment, now });
    expect(() => service.approve({ enrollmentId, tier: "observe", now }))
      .toThrow(/not ready/);

    service.reveal({ enrollmentId, nonce: initiatorNonce.toString("base64"), now });
    const later = now + 6 * 60_000;
    expect(() => service.approve({ enrollmentId, tier: "observe", now: later }))
      .toThrow(/expired/);
    expect(() => service.status(enrollmentId, later)).toThrow(/no such enrollment|expired/);
  });

  test("approve copies the TLS pin from the verified card; tls-absent cards grant none (§11.2)", () => {
    const { service, initiatorCard, initiatorNonce, commitment } = setup();
    const pin = "d".repeat(64);
    const tlsCard = { ...initiatorCard, tls: { spkiFingerprint: pin } };

    // A tls-absent card grants no pin field at all.
    const plain = service.begin({ card: initiatorCard, commitment });
    service.reveal({ enrollmentId: plain.enrollmentId, nonce: initiatorNonce.toString("base64") });
    expect(service.approve({ enrollmentId: plain.enrollmentId, tier: "observe" }).tlsSpkiFingerprint)
      .toBeUndefined();

    // A verified TLS-advertising card carries its pin into the grant.
    const initiator = freshIdentity();
    const tlsSignedCard = buildSignedNodeCard(initiator, {
      nodeId: "tls-node",
      label: "tls-air",
      version: "0.9.0",
      capabilities: ["observe"],
      endpoints: ["https://192.168.18.10:43111"],
      tls: { spkiFingerprint: pin },
    });
    const tlsNonce = randomBytes(32);
    const tlsCommitment = createEnrollmentCommitment(tlsNonce, tlsSignedCard.signature);
    const session = service.begin({ card: tlsSignedCard, commitment: tlsCommitment });
    service.reveal({ enrollmentId: session.enrollmentId, nonce: tlsNonce.toString("base64") });
    expect(service.approve({ enrollmentId: session.enrollmentId, tier: "control" }).tlsSpkiFingerprint)
      .toBe(pin);

    // A card whose tls field fails §11.2 runtime validation never begins.
    expect(() => service.begin({
      card: { ...tlsCard, tls: { spkiFingerprint: "ABC" } },
      commitment,
    })).toThrow(TrustEnrollmentError);
  });

  test("reject marks the session terminal", () => {
    const { service, initiatorCard, commitment } = setup();
    const { enrollmentId } = service.begin({ card: initiatorCard, commitment });
    service.reject({ enrollmentId });
    expect(service.status(enrollmentId)).toBe("rejected");
  });
});

describe("trust endpoint rate limiter", () => {
  test("allows within the limit, blocks beyond it, recovers after the window", () => {
    const limiter = new TrustEndpointRateLimiter(3, 60_000);
    const now = Date.now();
    expect(limiter.allow("192.168.18.9", now)).toBe(true);
    expect(limiter.allow("192.168.18.9", now + 1)).toBe(true);
    expect(limiter.allow("192.168.18.9", now + 2)).toBe(true);
    expect(limiter.allow("192.168.18.9", now + 3)).toBe(false);
    expect(limiter.allow("192.168.18.10", now + 3)).toBe(true);
    expect(limiter.allow("192.168.18.9", now + 61_000)).toBe(true);
  });
});
