import { createHash, createHmac } from "node:crypto";

import { EFF_SHORT_WORDLIST } from "./eff-short-wordlist.js";

/**
 * Enrollment confirmation codes (docs/proposals/mesh-trust-cone.md, amended
 * after review): the SAS is computed only after a commit-then-reveal nonce
 * exchange, so a MITM relaying both legs gets exactly one blind guess instead
 * of an offline birthday search.
 */

export const SAS_WORD_COUNT = 6;

/** base64 sha256 of nonce ‖ cardSignature — binds the nonce to the committed card. */
export function createEnrollmentCommitment(nonce: Buffer, cardSignature: string): string {
  return createHash("sha256")
    .update(Buffer.concat([nonce, Buffer.from(cardSignature, "utf8")]))
    .digest("base64");
}

export function verifyEnrollmentCommitment(
  commitment: string,
  nonce: Buffer,
  cardSignature: string,
): boolean {
  const expected = createEnrollmentCommitment(nonce, cardSignature);
  return timingSafeEqualString(expected, commitment);
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}

/**
 * Six words (~62 bits with the 1296-word EFF short list) from a
 * domain-separated transcript: HMAC key binds the protocol version and both
 * sorted key IDs; the message covers the challenge ID, both full public keys,
 * both node IDs, and both nonces in sorted-key-ID order. Both sides compute
 * the same code regardless of who initiated. Indices use rejection sampling
 * to avoid modulo bias.
 */
export const ENROLLMENT_PROTOCOL_VERSION = "openscout-mesh-enroll-v1";

export function computeEnrollmentSas(input: {
  challengeId: string;
  keyIdA: string;
  keyIdB: string;
  publicKeyA: string;
  publicKeyB: string;
  nodeIdA: string;
  nodeIdB: string;
  nonceA: Buffer;
  nonceB: Buffer;
  wordCount?: number;
}): string[] {
  const wordCount = input.wordCount ?? SAS_WORD_COUNT;
  const first = input.keyIdA <= input.keyIdB ? {
    keyId: input.keyIdA, publicKey: input.publicKeyA, nodeId: input.nodeIdA, nonce: input.nonceA,
  } : {
    keyId: input.keyIdB, publicKey: input.publicKeyB, nodeId: input.nodeIdB, nonce: input.nonceB,
  };
  const second = input.keyIdA <= input.keyIdB ? {
    keyId: input.keyIdB, publicKey: input.publicKeyB, nodeId: input.nodeIdB, nonce: input.nonceB,
  } : {
    keyId: input.keyIdA, publicKey: input.publicKeyA, nodeId: input.nodeIdA, nonce: input.nonceA,
  };
  const digest = createHmac("sha256", `${ENROLLMENT_PROTOCOL_VERSION}\n${first.keyId}\n${second.keyId}`)
    .update([
      ENROLLMENT_PROTOCOL_VERSION,
      input.challengeId,
      first.keyId,
      first.publicKey,
      first.nodeId,
      first.nonce.toString("base64"),
      second.keyId,
      second.publicKey,
      second.nodeId,
      second.nonce.toString("base64"),
    ].join("\n"))
    .digest();

  const words: string[] = [];
  // Largest multiple of the wordlist size that fits in 16 bits.
  const limit = Math.floor(0x10000 / EFF_SHORT_WORDLIST.length) * EFF_SHORT_WORDLIST.length;
  for (let offset = 0; offset + 2 <= digest.length && words.length < wordCount; offset += 2) {
    const chunk = digest.readUInt16BE(offset);
    if (chunk >= limit) continue;
    words.push(EFF_SHORT_WORDLIST[chunk % EFF_SHORT_WORDLIST.length]!);
  }
  if (words.length < wordCount) {
    // Practically unreachable (16 chunks, ~98.9% acceptance each); fall back
    // to plain modulo rather than fail an enrollment.
    for (let offset = 0; offset + 2 <= digest.length && words.length < wordCount; offset += 2) {
      words.push(EFF_SHORT_WORDLIST[digest.readUInt16BE(offset) % EFF_SHORT_WORDLIST.length]!);
    }
  }
  return words;
}

export function formatSas(words: string[]): string {
  return words.join("-");
}
