// Noise Protocol Framework implementation for Pairing.
//
// Implements the core Noise machinery (CipherState, SymmetricState,
// HandshakeState) with two patterns:
//
//   XX  — mutual authentication, both sides anonymous at first (QR pairing)
//   IK  — initiator knows responder's key (trusted reconnect)
//
// Cipher suite: Noise_XX_25519_AESGCM_SHA256
//
// Built on @noble/* libraries (audited, zero-dep, pure JS):
//   - @noble/curves: X25519 key agreement
//   - @noble/ciphers: AES-256-GCM
//   - @noble/hashes: SHA-256, HKDF

import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyPair {
  publicKey: Uint8Array;   // 32 bytes
  privateKey: Uint8Array;  // 32 bytes
}

export type Role = "initiator" | "responder";

export type HandshakePattern = "XX" | "IK";

/** The result of a completed handshake. */
export interface NoiseSession {
  /** Encrypt outgoing messages. */
  encrypt(plaintext: Uint8Array): Uint8Array;
  /** Decrypt incoming messages. */
  decrypt(ciphertext: Uint8Array): Uint8Array;
  /** The remote peer's static public key (authenticated during handshake). */
  remoteStaticKey: Uint8Array;
  /** The handshake hash — unique channel binding value. */
  handshakeHash: Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;

// Max nonce before rekey is needed (2^64 - 1 in practice, but we use Number).
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// ---------------------------------------------------------------------------
// CipherState — symmetric encryption with nonce counter
// ---------------------------------------------------------------------------

class CipherState {
  private key: Uint8Array | null;
  private nonce: number;

  constructor(key: Uint8Array | null = null) {
    this.key = key;
    this.nonce = 0;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.nonce >= MAX_NONCE) throw new Error("Noise: nonce exhausted");

    const nonce = this.nonceBytes();
    const cipher = gcm(this.key, nonce, ad);
    const ciphertext = cipher.encrypt(plaintext);
    this.nonce++;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.nonce >= MAX_NONCE) throw new Error("Noise: nonce exhausted");

    const nonce = this.nonceBytes();
    const cipher = gcm(this.key, nonce, ad);
    const plaintext = cipher.decrypt(ciphertext);
    this.nonce++;
    return plaintext;
  }

  // Noise spec: 4 zero bytes + 8-byte little-endian nonce = 12-byte AES-GCM nonce.
  private nonceBytes(): Uint8Array {
    const buf = new Uint8Array(12);
    const view = new DataView(buf.buffer);
    // Little-endian uint64 at offset 4.  Number is safe up to 2^53.
    view.setUint32(4, this.nonce & 0xffffffff, true);
    view.setUint32(8, Math.floor(this.nonce / 0x100000000), true);
    return buf;
  }
}

// ---------------------------------------------------------------------------
// SymmetricState — handshake hash and chaining key
// ---------------------------------------------------------------------------

class SymmetricState {
  private ck: Uint8Array;   // chaining key
  private h: Uint8Array;    // handshake hash
  private cipher: CipherState;

  constructor(protocolName: string) {
    const nameBytes = new TextEncoder().encode(protocolName);
    if (nameBytes.length <= HASHLEN) {
      // Pad with zeros to HASHLEN.
      this.h = new Uint8Array(HASHLEN);
      this.h.set(nameBytes);
    } else {
      this.h = sha256(nameBytes);
    }
    this.ck = new Uint8Array(this.h);
    this.cipher = new CipherState();
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.h);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const output = hkdf(sha256, inputKeyMaterial, this.ck, undefined, 64);
    this.ck = output.slice(0, 32);
    const tempK = output.slice(32, 64);
    this.cipher = new CipherState(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const output = hkdf(sha256, new Uint8Array(0), this.ck, undefined, 64);
    const k1 = output.slice(0, 32);
    const k2 = output.slice(32, 64);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// ---------------------------------------------------------------------------
// HandshakeState — executes a Noise handshake pattern
// ---------------------------------------------------------------------------

// Pattern definitions.
// Each message is an array of tokens processed in order.
// "e" = ephemeral key, "s" = static key, "ee"/"es"/"se"/"ss" = DH operations.

const PATTERNS: Record<HandshakePattern, { pre: string[][]; messages: string[][] }> = {
  XX: {
    pre: [],
    messages: [
      ["e"],                     // → e
      ["e", "ee", "s", "es"],   // ← e, ee, s, es
      ["s", "se"],              // → s, se
    ],
  },
  IK: {
    // Pre-message: initiator knows responder's static key.
    pre: [[], ["s"]],
    messages: [
      ["e", "es", "s", "ss"],   // → e, es, s, ss
      ["e", "ee", "se"],        // ← e, ee, se
    ],
  },
};

export class NoiseHandshake {
  private ss: SymmetricState;
  private s: KeyPair;                          // local static
  private e: KeyPair | null = null;            // local ephemeral
  private rs: Uint8Array | null = null;        // remote static public
  private re: Uint8Array | null = null;        // remote ephemeral public
  private role: Role;
  private pattern: string[][];
  private messageIndex = 0;

  /**
   * @param pattern   XX or IK
   * @param role      initiator or responder
   * @param staticKey local static key pair
   * @param remoteStaticKey  remote static public key (required for IK initiator)
   */
  constructor(
    pattern: HandshakePattern,
    role: Role,
    staticKey: KeyPair,
    remoteStaticKey?: Uint8Array,
  ) {
    const protocolName = `Noise_${pattern}_25519_AESGCM_SHA256`;
    this.ss = new SymmetricState(protocolName);
    this.s = staticKey;
    this.role = role;
    this.pattern = PATTERNS[pattern].messages;

    // Process pre-messages — mix known static keys into the hash.
    const pre = PATTERNS[pattern].pre;
    if (pre.length > 0) {
      // pre[0] = initiator pre-message tokens, pre[1] = responder pre-message tokens
      for (const token of pre[0] ?? []) {
        if (token === "s") {
          const key = role === "initiator" ? staticKey.publicKey : remoteStaticKey;
          if (!key) throw new Error("Noise: missing initiator static key for pre-message");
          this.ss.mixHash(key);
          if (role === "responder") this.rs = key;
        }
      }
      for (const token of pre[1] ?? []) {
        if (token === "s") {
          const key = role === "responder" ? staticKey.publicKey : remoteStaticKey;
          if (!key) throw new Error("Noise: missing responder static key for pre-message (IK requires it)");
          this.ss.mixHash(key);
          if (role === "initiator") this.rs = key;
        }
      }
    }

    if (remoteStaticKey && !this.rs) {
      this.rs = remoteStaticKey;
    }
  }

  /** True when it's our turn to send the next message. */
  isMySend(): boolean {
    // Message 0 is initiator's send, message 1 is responder's send, etc.
    const senderIsInitiator = this.messageIndex % 2 === 0;
    return (this.role === "initiator") === senderIsInitiator;
  }

  /** True when the handshake is complete (all messages exchanged). */
  isComplete(): boolean {
    return this.messageIndex >= this.pattern.length;
  }

  /**
   * Write the next handshake message (our turn to send).
   * Returns the message bytes to transmit.
   * Optionally include a payload in the last message.
   */
  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.isMySend()) throw new Error("Noise: not our turn to send");
    if (this.isComplete()) throw new Error("Noise: handshake already complete");

    const tokens = this.pattern[this.messageIndex]!;
    const parts: Uint8Array[] = [];

    for (const token of tokens) {
      switch (token) {
        case "e": {
          this.e = generateKeyPair();
          parts.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          break;
        }
        case "s": {
          const encrypted = this.ss.encryptAndHash(this.s.publicKey);
          parts.push(encrypted);
          break;
        }
        default:
          // DH tokens: ee, es, se, ss
          this.performDH(token);
          break;
      }
    }

    // Encrypt and append payload (possibly empty).
    parts.push(this.ss.encryptAndHash(payload));

    this.messageIndex++;
    return concat(...parts);
  }

  /**
   * Read an incoming handshake message (their turn to send).
   * Returns any decrypted payload.
   */
  readMessage(message: Uint8Array): Uint8Array {
    if (this.isMySend()) throw new Error("Noise: not our turn to receive");
    if (this.isComplete()) throw new Error("Noise: handshake already complete");

    const tokens = this.pattern[this.messageIndex]!;
    let offset = 0;

    for (const token of tokens) {
      switch (token) {
        case "e": {
          this.re = message.slice(offset, offset + DHLEN);
          offset += DHLEN;
          this.ss.mixHash(this.re);
          break;
        }
        case "s": {
          // If the cipher has a key, the static key is encrypted (+ 16 byte tag).
          const len = this.ss["cipher"].hasKey() ? DHLEN + TAGLEN : DHLEN;
          const temp = message.slice(offset, offset + len);
          offset += len;
          this.rs = this.ss.decryptAndHash(temp);
          break;
        }
        default:
          this.performDH(token);
          break;
      }
    }

    // Remaining bytes are the encrypted payload.
    const payload = this.ss.decryptAndHash(message.slice(offset));

    this.messageIndex++;
    return payload;
  }

  /**
   * After the handshake is complete, split into transport cipher states.
   */
  finalize(): NoiseSession {
    if (!this.isComplete()) throw new Error("Noise: handshake not complete");
    if (!this.rs) throw new Error("Noise: remote static key not established");

    const [c1, c2] = this.ss.split();
    const handshakeHash = this.ss.getHandshakeHash();

    // c1 is initiator→responder, c2 is responder→initiator.
    const [sendCipher, recvCipher] =
      this.role === "initiator" ? [c1, c2] : [c2, c1];

    return {
      encrypt(plaintext: Uint8Array): Uint8Array {
        return sendCipher.encryptWithAd(new Uint8Array(0), plaintext);
      },
      decrypt(ciphertext: Uint8Array): Uint8Array {
        return recvCipher.decryptWithAd(new Uint8Array(0), ciphertext);
      },
      remoteStaticKey: new Uint8Array(this.rs),
      handshakeHash,
    };
  }

  // ---------------------------------------------------------------------------
  // DH token processing
  // ---------------------------------------------------------------------------

  private performDH(token: string): void {
    // Token letters: first = initiator's key type, second = responder's key type.
    // Each side uses its own private key + the remote public key of the matching type.
    const [initiatorKeyType, responderKeyType] = token.split("") as ["e" | "s", "e" | "s"];
    const isInitiator = this.role === "initiator";

    const myType = isInitiator ? initiatorKeyType : responderKeyType;
    const theirType = isInitiator ? responderKeyType : initiatorKeyType;

    const myPrivate = myType === "e" ? this.e?.privateKey : this.s.privateKey;
    const theirPublic = theirType === "e" ? this.re : this.rs;

    if (!myPrivate) throw new Error(`Noise: missing local ${myType} key for DH(${token})`);
    if (!theirPublic) throw new Error(`Noise: missing remote ${theirType} key for DH(${token})`);

    this.ss.mixKey(dh(myPrivate, theirPublic));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
