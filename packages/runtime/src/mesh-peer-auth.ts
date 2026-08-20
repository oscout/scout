import { createHash, randomBytes } from "node:crypto";

import {
  nodeKeyId,
  signNodePayload,
  verifyNodeSignature,
  type NodeIdentity,
} from "./node-identity.js";

/**
 * Mesh trust cone (docs/proposals/mesh-trust-cone.md section 4): every
 * non-public peer→broker request carries an Ed25519 signature over the request
 * plus a timestamp and nonce. No shared secrets; enrollment state is the only
 * trust root. Loopback clients are handled by the router gate, not here.
 */

export const PEER_AUTH_HEADERS = {
  peer: "x-openscout-peer",
  ts: "x-openscout-ts",
  nonce: "x-openscout-nonce",
  signature: "x-openscout-signature",
} as const;

export type MeshPeerTier = "observe" | "control";

export const PEER_AUTH_MAX_SKEW_MS = 5 * 60 * 1_000;

/** Grace below broker boot time for peer clocks running slightly behind. */
export const PRE_BOOT_GRACE_MS = 15 * 1_000;

export type PeerAuthPrincipal = {
  /** full SHA-256 key ID of the enrolled peer */
  keyId: string;
  tier: MeshPeerTier;
};

export type PeerAuthLookup = (keyId: string) =>
  | { publicKey: string; tier: MeshPeerTier }
  | undefined;

/** Durable-or-memory atomic nonce claim (SQLite in the broker, map in tests). */
export type PeerNonceClaim = {
  claim: (keyId: string, nonce: string, now: number) => boolean;
};

export type PeerRequestHeaders = {
  peer?: string | undefined;
  ts?: string | undefined;
  nonce?: string | undefined;
  signature?: string | undefined;
};

export type VerifyPeerRequestResult =
  | { ok: true; principal: PeerAuthPrincipal }
  | { ok: false; reason: string };

const SIGNING_PAYLOAD_VERSION = "v1";

function assertNoNewlines(component: string, name: string): void {
  if (component.includes("\n") || component.includes("\r")) {
    throw new Error(`peer request ${name} must not contain newlines`);
  }
}

/**
 * Canonical signing payload. Binds the destination node key ID so a
 * request signed for node A cannot be replayed against node B, and every
 * component is newline-checked so the `\n` framing cannot be smuggled across
 * field boundaries.
 */
export function peerRequestSigningPayload(input: {
  method: string;
  /** pathname + query, exactly as sent/received */
  path: string;
  bodySha256Hex: string;
  destinationKeyId: string;
  ts: number;
  nonce: string;
}): string {
  const method = input.method.toUpperCase();
  assertNoNewlines(method, "method");
  assertNoNewlines(input.path, "path");
  assertNoNewlines(input.bodySha256Hex, "body hash");
  assertNoNewlines(input.destinationKeyId, "destination key ID");
  assertNoNewlines(input.nonce, "nonce");
  return [
    SIGNING_PAYLOAD_VERSION,
    method,
    input.path,
    input.bodySha256Hex,
    input.destinationKeyId,
    String(input.ts),
    input.nonce,
  ].join("\n");
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Sign an outgoing peer request; returns the headers to attach. */
export function signPeerRequest(
  identity: NodeIdentity,
  input: {
    method: string;
    path: string;
    body?: Buffer | string;
    /** key ID of the node this request is addressed to */
    destinationKeyId: string;
    ts?: number;
    nonce?: string;
  },
): Record<typeof PEER_AUTH_HEADERS[keyof typeof PEER_AUTH_HEADERS], string> {
  const ts = input.ts ?? Date.now();
  const nonce = input.nonce ?? randomBytes(16).toString("base64");
  const payload = peerRequestSigningPayload({
    method: input.method,
    path: input.path,
    bodySha256Hex: sha256Hex(input.body ?? ""),
    destinationKeyId: input.destinationKeyId,
    ts,
    nonce,
  });
  return {
    [PEER_AUTH_HEADERS.peer]: nodeKeyId(identity.publicKey),
    [PEER_AUTH_HEADERS.ts]: String(ts),
    [PEER_AUTH_HEADERS.nonce]: nonce,
    [PEER_AUTH_HEADERS.signature]: signNodePayload(identity, payload),
  };
}

/**
 * In-memory replay guard: nonces are remembered per key ID for the skew
 * window, then swept. The cache dies with the process, so verifiers must also
 * pass `bootedAt` — timestamps predating boot are rejected before the cache is
 * consulted, closing the restart replay hole.
 */
export class PeerNonceCache implements PeerNonceClaim {
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(
    private readonly maxSkewMs: number = PEER_AUTH_MAX_SKEW_MS,
    private readonly maxEntriesPerPeer = 10_000,
  ) {}

  /** Returns true when the nonce is fresh (and records it); false on replay. */
  claim(keyId: string, nonce: string, now: number = Date.now()): boolean {
    this.sweep(now);
    let forPeer = this.seen.get(keyId);
    if (!forPeer) {
      forPeer = new Map();
      this.seen.set(keyId, forPeer);
    }
    if (forPeer.has(nonce)) {
      return false;
    }
    if (forPeer.size >= this.maxEntriesPerPeer) {
      return false;
    }
    forPeer.set(nonce, now + this.maxSkewMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [keyId, nonces] of this.seen) {
      for (const [nonce, expiresAt] of nonces) {
        if (expiresAt <= now) {
          nonces.delete(nonce);
        }
      }
      if (nonces.size === 0) {
        this.seen.delete(keyId);
      }
    }
  }
}

export function verifyPeerRequest(input: {
  method: string;
  /** pathname including query string, exactly as received */
  path: string;
  body?: Buffer | string;
  headers: PeerRequestHeaders;
  /** this node's key ID; a request signed for another node is rejected */
  destinationKeyId: string;
  lookupPeer: PeerAuthLookup;
  nonceClaim: PeerNonceClaim;
  /**
   * Process boot time. Timestamps before boot are rejected (small grace for
   * clock skew), closing the in-window replay hole left by the nonce cache
   * being in-memory only. Requests genuinely in flight across a restart are
   * retried by the caller.
   */
  bootedAt: number;
  now?: number;
  maxSkewMs?: number;
}): VerifyPeerRequestResult {
  const now = input.now ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? PEER_AUTH_MAX_SKEW_MS;
  const { peer, ts, nonce, signature } = input.headers;

  if (!peer || !ts || !nonce || !signature) {
    return { ok: false, reason: "missing peer auth headers" };
  }
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > maxSkewMs) {
    return { ok: false, reason: "timestamp outside acceptable skew" };
  }
  if (timestamp < input.bootedAt - PRE_BOOT_GRACE_MS) {
    return { ok: false, reason: "timestamp predates broker boot" };
  }
  const enrolled = input.lookupPeer(peer);
  if (!enrolled) {
    return { ok: false, reason: `peer ${peer} is not enrolled` };
  }
  let payload: string;
  try {
    payload = peerRequestSigningPayload({
      method: input.method,
      path: input.path,
      bodySha256Hex: sha256Hex(input.body ?? ""),
      destinationKeyId: input.destinationKeyId,
      ts: timestamp,
      nonce,
    });
  } catch {
    return { ok: false, reason: "malformed signing components" };
  }
  if (!verifyNodeSignature(enrolled.publicKey, payload, signature)) {
    return { ok: false, reason: "invalid signature" };
  }
  if (!input.nonceClaim.claim(peer, nonce, now)) {
    return { ok: false, reason: "nonce replay" };
  }
  return { ok: true, principal: { keyId: peer, tier: enrolled.tier } };
}
