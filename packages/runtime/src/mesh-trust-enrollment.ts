import { randomBytes } from "node:crypto";

import {
  verifySignedNodeCard,
  type SignedNodeCard,
} from "./node-identity.js";
import {
  computeEnrollmentSas,
  verifyEnrollmentCommitment,
} from "./mesh-sas.js";
import type { MeshPeerTier } from "./mesh-peer-auth.js";

/**
 * Enrollment state machine (docs/proposals/mesh-trust-cone.md v2).
 *
 * Commit-reveal handshake:
 *   1. initiator → begin(card, commitment)        responder stores pending,
 *      returns its card + responder nonce
 *   2. initiator → reveal(enrollmentId, nonce)     responder verifies the
 *      commitment, both sides can now compute the same SAS words
 *   3. humans compare the words + short fingerprints on both screens
 *   4. each side's operator approves locally (loopback only) with a tier
 *      chosen on the granting side — never carried in the enrollee's payload
 *
 * A MITM relaying both legs must guess the initiator nonce before reveal:
 * one blind guess, not an offline search.
 */

export const ENROLLMENT_TTL_MS = 5 * 60 * 1_000;

export type EnrollmentGrantVia = "sas" | "github" | "ssh";

export type TrustedPeerGrant = {
  /** full SHA-256 key ID — the canonical peer identity */
  keyId: string;
  publicKey: string;
  /** display-only human anchor */
  fingerprint: string;
  nodeId?: string;
  /** unverified, display-only */
  label: string;
  tier: MeshPeerTier;
  grantedVia: EnrollmentGrantVia;
  grantedAt: number;
  /**
   * §11.2: the peer's TLS SPKI pin, copied from its VERIFIED signed card when
   * the card advertises one — signed-card-derived, never observed from the
   * wire, so a MITM cannot plant a pin the identity key holder didn't attest.
   */
  tlsSpkiFingerprint?: string;
};

export type EnrollmentSessionState = "pending" | "ready" | "approved" | "rejected";

/** Operator-facing view of an in-flight enrollment (loopback surfaces only). */
export type EnrollmentSessionSummary = {
  id: string;
  state: EnrollmentSessionState;
  /** the remote (initiator) card — label/nodeId are unverified, display-only */
  remoteCard: {
    keyId: string;
    fingerprint: string;
    label: string;
    nodeId: string;
  };
  /** present once the reveal has been verified (state "ready") */
  sasWords?: string[];
  createdAt: number;
  expiresAt: number;
};

export type EnrollmentSession = {
  id: string;
  state: EnrollmentSessionState;
  /** the remote (initiator) card — label/nodeId are unverified, display-only */
  remoteCard: SignedNodeCard;
  commitment: string;
  responderNonce: Buffer;
  createdAt: number;
  expiresAt: number;
  sasWords?: string[];
  approvedTier?: MeshPeerTier;
};

/** The local card identity the service needs to compute the SAS transcript. */
export type EnrollmentLocalIdentity = {
  keyId: string;
  publicKey: string;
  nodeId: string;
  fingerprint: string;
};

export class TrustEnrollmentError extends Error {
  constructor(
    readonly reason:
      | "invalid-card"
      | "unknown-enrollment"
      | "expired"
      | "bad-state"
      | "commitment-mismatch"
      | "self-enrollment",
    message: string,
  ) {
    super(message);
    this.name = "TrustEnrollmentError";
  }
}

export class TrustEnrollmentService {
  private readonly sessions = new Map<string, EnrollmentSession>();

  constructor(
    private readonly local: EnrollmentLocalIdentity,
    private readonly ttlMs: number = ENROLLMENT_TTL_MS,
  ) {}

  /** Step 1 (responder side, public route): accept a begin, return our nonce. */
  begin(input: {
    card: SignedNodeCard;
    commitment: string;
    remoteAddress?: string;
    now?: number;
  }): { enrollmentId: string; responderNonce: string } {
    const now = input.now ?? Date.now();
    this.sweep(now);
    if (!verifySignedNodeCard(input.card, now)) {
      throw new TrustEnrollmentError("invalid-card", "initiator card failed verification");
    }
    if (input.card.keyId === this.local.keyId) {
      throw new TrustEnrollmentError("self-enrollment", "cannot enroll with self");
    }
    const session: EnrollmentSession = {
      id: randomBytes(9).toString("base64url"),
      state: "pending",
      remoteCard: input.card,
      commitment: input.commitment,
      responderNonce: randomBytes(32),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return {
      enrollmentId: session.id,
      responderNonce: session.responderNonce.toString("base64"),
    };
  }

  /** Step 2 (responder side, public route): verify the reveal, compute the SAS. */
  reveal(input: {
    enrollmentId: string;
    nonce: string;
    now?: number;
  }): { sasWords: string[] } {
    const now = input.now ?? Date.now();
    const session = this.requireSession(input.enrollmentId, now);
    if (session.state !== "pending") {
      throw new TrustEnrollmentError("bad-state", `enrollment is ${session.state}, not pending`);
    }
    const initiatorNonce = Buffer.from(input.nonce, "base64");
    if (initiatorNonce.length < 16) {
      throw new TrustEnrollmentError("commitment-mismatch", "initiator nonce too short");
    }
    if (!verifyEnrollmentCommitment(session.commitment, initiatorNonce, session.remoteCard.signature)) {
      throw new TrustEnrollmentError("commitment-mismatch", "revealed nonce does not match commitment");
    }
    session.sasWords = this.sasFor(session, initiatorNonce);
    session.state = "ready";
    return { sasWords: session.sasWords };
  }

  /**
   * Step 4 (loopback only): the local operator confirms the words matched and
   * picks the tier to grant. Returns the grant to persist in trusted_peers.
   */
  approve(input: {
    enrollmentId: string;
    tier: MeshPeerTier;
    now?: number;
  }): TrustedPeerGrant {
    const now = input.now ?? Date.now();
    const session = this.requireSession(input.enrollmentId, now);
    if (session.state !== "ready") {
      throw new TrustEnrollmentError("bad-state", `enrollment is ${session.state}, not ready`);
    }
    session.state = "approved";
    session.approvedTier = input.tier;
    return {
      keyId: session.remoteCard.keyId,
      publicKey: session.remoteCard.publicKey,
      fingerprint: session.remoteCard.fingerprint,
      nodeId: session.remoteCard.nodeId,
      label: session.remoteCard.label,
      tier: input.tier,
      grantedVia: "sas",
      grantedAt: now,
      // §11.2: the first verified TLS-advertising card writes the durable
      // pin. A tls-absent card leaves the field undefined — and the store's
      // never-clear rule keeps any existing pin intact on re-enrollment.
      ...(session.remoteCard.tls
        ? { tlsSpkiFingerprint: session.remoteCard.tls.spkiFingerprint }
        : {}),
    };
  }

  reject(input: { enrollmentId: string; now?: number }): void {
    const session = this.requireSession(input.enrollmentId, input.now ?? Date.now());
    session.state = "rejected";
  }

  status(enrollmentId: string, now: number = Date.now()): EnrollmentSessionState {
    return this.requireSession(enrollmentId, now).state;
  }

  /**
   * Loopback-only operator listing of in-flight enrollments (the responder
   * side of the handshake) so the local CLI can show the SAS words and pick a
   * session to approve.
   */
  list(now: number = Date.now()): EnrollmentSessionSummary[] {
    this.sweep(now);
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      state: session.state,
      remoteCard: {
        keyId: session.remoteCard.keyId,
        fingerprint: session.remoteCard.fingerprint,
        label: session.remoteCard.label,
        nodeId: session.remoteCard.nodeId,
      },
      ...(session.sasWords ? { sasWords: session.sasWords } : {}),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));
  }

  /**
   * Initiator-side helper: compute the same SAS after the reveal round-trip,
   * from the responder's card and both nonces.
   */
  static initiatorSas(input: {
    challengeId: string;
    ownCard: SignedNodeCard;
    ownNonce: Buffer;
    responderCard: SignedNodeCard;
    responderNonce: Buffer;
  }): string[] {
    return computeEnrollmentSas({
      challengeId: input.challengeId,
      keyIdA: input.ownCard.keyId,
      keyIdB: input.responderCard.keyId,
      publicKeyA: input.ownCard.publicKey,
      publicKeyB: input.responderCard.publicKey,
      nodeIdA: input.ownCard.nodeId,
      nodeIdB: input.responderCard.nodeId,
      nonceA: input.ownNonce,
      nonceB: input.responderNonce,
    });
  }

  private sasFor(session: EnrollmentSession, initiatorNonce: Buffer): string[] {
    return computeEnrollmentSas({
      challengeId: session.id,
      keyIdA: session.remoteCard.keyId,
      keyIdB: this.local.keyId,
      publicKeyA: session.remoteCard.publicKey,
      publicKeyB: this.local.publicKey,
      nodeIdA: session.remoteCard.nodeId,
      nodeIdB: this.local.nodeId,
      nonceA: initiatorNonce,
      nonceB: session.responderNonce,
    });
  }

  private requireSession(enrollmentId: string, now: number): EnrollmentSession {
    const session = this.sessions.get(enrollmentId);
    if (!session) {
      throw new TrustEnrollmentError("unknown-enrollment", "no such enrollment");
    }
    if (session.expiresAt <= now && session.state !== "approved" && session.state !== "rejected") {
      this.sessions.delete(enrollmentId);
      throw new TrustEnrollmentError("expired", "enrollment expired");
    }
    return session;
  }

  private sweep(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }
}

/** Sliding-window rate limiter for the public trust endpoints. */
export class TrustEndpointRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = 10,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Returns true when the caller may proceed; false when over the limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
