import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  assertTestIsolatedUserData,
  resolveOpenScoutSupportPaths,
} from "./support-paths.js";

/**
 * Mesh trust cone v2 (docs/proposals/mesh-trust-cone.md): every node owns a
 * long-term Ed25519 identity. The private key never leaves the support
 * directory. Two derived identities have distinct roles:
 *
 * - key ID — full SHA-256 hex of the public key; the canonical machine
 *   identity (trusted_peers PK, signing header, replay-claim key).
 * - fingerprint — `osc1:xxxx-xxxx`, 40 bits, display-only; shown to humans
 *   during enrollment. Never used for lookup or authorization.
 */

export const NODE_IDENTITY_FILE = "node-identity.json";
export const NODE_FINGERPRINT_PREFIX = "osc1";
export const NODE_CARD_TTL_MS = 24 * 60 * 60 * 1_000;
const stableNodeQualifierCache = new Map<string, string>();

export type NodeIdentity = {
  version: 1;
  /** base64 DER (spki) Ed25519 public key */
  publicKey: string;
  /** base64 DER (pkcs8) Ed25519 private key — never leaves this machine */
  privateKey: string;
  createdAt: number;
  /**
   * Stable, human-readable machine qualifier used by broker and agent ids.
   * Persisting it prevents DHCP/mDNS hostname collision suffixes from changing
   * local authority across broker restarts.
   */
  nodeQualifier?: string;
};

/** §11.2: additive TLS attestation on the signed node card (P1.5). */
export type NodeCardTls = {
  /** SHA-256 hex (64 lowercase) of the TLS certificate's SubjectPublicKeyInfo DER */
  spkiFingerprint: string;
};

export type SignedNodeCard = {
  nodeId: string;
  label: string;
  publicKey: string;
  /** full SHA-256 hex of the public key — canonical machine identity */
  keyId: string;
  /** display-only human anchor */
  fingerprint: string;
  version: string;
  capabilities: string[];
  endpoints: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  /**
   * Optional §11.2 TLS attestation. Included in the signed canonical-JSON
   * payload when present, so P1 verifiers accept it (hashed like every other
   * field) and P1.5 verifiers accept its absence.
   */
  tls?: NodeCardTls;
  /** base64 Ed25519 signature over canonicalJson of every field above */
  signature: string;
};

export function nodeIdentityPath(supportDirectory?: string): string {
  const dir = supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  return join(dir, NODE_IDENTITY_FILE);
}

export function loadOrCreateNodeIdentity(supportDirectory?: string): NodeIdentity {
  const path = nodeIdentityPath(supportDirectory);
  if (existsSync(path)) {
    return readAndValidateNodeIdentity(path);
  }
  return createNodeIdentity(supportDirectory);
}

/**
 * Return the machine qualifier persisted with the long-term node key, creating
 * it from the current hostname only once. Display names may follow the live
 * hostname; routing authority must not.
 */
export function loadOrCreateStableNodeQualifier(
  fallbackName: string,
  supportDirectory?: string,
): string {
  const path = nodeIdentityPath(supportDirectory);
  const cached = stableNodeQualifierCache.get(path);
  if (cached) {
    return cached;
  }
  const identity = loadOrCreateNodeIdentity(supportDirectory);
  const existing = normalizeNodeQualifier(identity.nodeQualifier);
  if (existing) {
    stableNodeQualifierCache.set(path, existing);
    return existing;
  }

  const nodeQualifier = normalizeNodeQualifier(fallbackName) || "local";
  persistNodeIdentity(path, {
    ...identity,
    nodeQualifier,
  });
  stableNodeQualifierCache.set(path, nodeQualifier);
  return nodeQualifier;
}

/** Read the stable qualifier without creating user state. */
export function readStableNodeQualifier(supportDirectory?: string): string | null {
  const path = nodeIdentityPath(supportDirectory);
  const cached = stableNodeQualifierCache.get(path);
  if (cached) {
    return cached;
  }
  if (!existsSync(path)) {
    return null;
  }
  const nodeQualifier = normalizeNodeQualifier(readAndValidateNodeIdentity(path).nodeQualifier);
  if (nodeQualifier) {
    stableNodeQualifierCache.set(path, nodeQualifier);
  }
  return nodeQualifier || null;
}

export function resolveStableLocalNodeId(input: {
  configuredNodeId?: string;
  nodeName: string;
  meshId: string;
  supportDirectory?: string;
}): string {
  const nodeQualifier = loadOrCreateStableNodeQualifier(input.nodeName, input.supportDirectory);
  const configuredNodeId = input.configuredNodeId?.trim();
  if (configuredNodeId) {
    return configuredNodeId;
  }
  const meshQualifier = normalizeNodeQualifier(input.meshId) || "openscout";
  return `${nodeQualifier}-${meshQualifier}`;
}

function readAndValidateNodeIdentity(path: string): NodeIdentity {
  let parsed: NodeIdentity;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as NodeIdentity;
  } catch {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  if (parsed.version !== 1 || !parsed.publicKey || !parsed.privateKey) {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  if (parsed.nodeQualifier !== undefined && normalizeNodeQualifier(parsed.nodeQualifier) !== parsed.nodeQualifier) {
    throw new Error(`Corrupt node identity at ${path}; remove it to generate a fresh one.`);
  }
  // Verify the pair: re-derive the public key from the private key.
  try {
    const derived = createPublicKey(importPrivateKey(parsed.privateKey))
      .export({ type: "spki", format: "der" })
      .toString("base64");
    if (derived !== parsed.publicKey) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(`Node identity at ${path} has mismatched or invalid keys; remove it to generate a fresh one.`);
  }
  return parsed;
}

function normalizeNodeQualifier(value: unknown): string {
  return typeof value === "string"
    ? value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
    : "";
}

function persistNodeIdentity(path: string, identity: NodeIdentity): void {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function createNodeIdentity(supportDirectory?: string): NodeIdentity {
  if (!supportDirectory) {
    assertTestIsolatedUserData("write the node identity", "OPENSCOUT_SUPPORT_DIRECTORY");
  }
  const path = nodeIdentityPath(supportDirectory);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity: NodeIdentity = {
    version: 1,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    createdAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Exclusive create: a concurrent first-run can never replace an identity
    // that another process already started announcing.
    writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readAndValidateNodeIdentity(path);
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; mode on create already restrictive
  }
  return identity;
}

/** Canonical machine identity: full SHA-256 hex of the DER public key. */
export function nodeKeyId(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex");
}

/** Display-only human anchor: `osc1:7f3k-9q2x`. Not used for authz or lookup. */
export function nodeFingerprint(publicKeyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest();
  const encoded = base32Encode(digest.subarray(0, 10)).toLowerCase();
  return `${NODE_FINGERPRINT_PREFIX}:${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`;
}

export function signNodePayload(identity: NodeIdentity, payload: Buffer | string): string {
  const key = importPrivateKey(identity.privateKey);
  return sign(null, typeof payload === "string" ? Buffer.from(payload, "utf8") : payload, key).toString("base64");
}

export function verifyNodeSignature(
  publicKeyBase64: string,
  payload: Buffer | string,
  signatureBase64: string,
): boolean {
  try {
    const key = importPublicKey(publicKeyBase64);
    return verify(
      null,
      typeof payload === "string" ? Buffer.from(payload, "utf8") : payload,
      key,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Canonical JSON, cross-language: object keys sorted (by UTF-16 code unit,
 * matching JSON.stringify ordering on sorted keys), no insignificant
 * whitespace, applied recursively. Swift and other clients must reproduce
 * this byte-for-byte; covered by golden-vector tests.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function buildSignedNodeCard(
  identity: NodeIdentity,
  fields: {
    nodeId: string;
    label: string;
    version: string;
    capabilities: string[];
    endpoints: string[];
    /**
     * §11.2 attestation wired from the node's TLS identity when it has one
     * (`{ spkiFingerprint: tlsIdentity.spkiFingerprint }`). Omitted entirely
     * on nodes without a TLS identity — the field's optionality is the
     * versioning, so P1 cards stay valid.
     */
    tls?: NodeCardTls;
  },
  now: number = Date.now(),
): SignedNodeCard {
  const unsigned = {
    nodeId: fields.nodeId,
    label: fields.label,
    publicKey: identity.publicKey,
    keyId: nodeKeyId(identity.publicKey),
    fingerprint: nodeFingerprint(identity.publicKey),
    version: fields.version,
    capabilities: [...fields.capabilities].sort(),
    endpoints: [...fields.endpoints].sort(),
    issuedAt: now,
    expiresAt: now + NODE_CARD_TTL_MS,
    nonce: randomBytes(16).toString("base64"),
    ...(fields.tls ? { tls: { spkiFingerprint: fields.tls.spkiFingerprint } } : {}),
  };
  return {
    ...unsigned,
    signature: signNodePayload(identity, canonicalJson(unsigned)),
  };
}

export function verifySignedNodeCard(card: SignedNodeCard, now: number = Date.now()): boolean {
  if (nodeKeyId(card.publicKey) !== card.keyId) {
    return false;
  }
  if (nodeFingerprint(card.publicKey) !== card.fingerprint) {
    return false;
  }
  if (!Number.isFinite(card.expiresAt) || card.expiresAt <= now) {
    return false;
  }
  // §11.2 hardening: a present tls field must be well-formed — a pin is only
  // ever stored from a signature-valid card carrying exactly 64 lowercase hex.
  if (card.tls !== undefined) {
    if (
      typeof card.tls !== "object"
      || card.tls === null
      || typeof card.tls.spkiFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(card.tls.spkiFingerprint)
    ) {
      return false;
    }
  }
  const { signature, ...unsigned } = card;
  return verifyNodeSignature(card.publicKey, canonicalJson(unsigned), signature);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function importPrivateKey(privateKeyBase64: string) {
  return createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
}

function importPublicKey(publicKeyBase64: string) {
  return createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
}
