// Identity management for Pairing.
//
// Each bridge has a persistent static key pair (its identity).  This module
// handles generation, persistence (~/.scout/pairing/identity.json), and QR payload
// creation for pairing with a phone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { generateKeyPair, type KeyPair } from "./noise.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PAIRING_DIR = join(homedir(), ".scout/pairing");
const IDENTITY_FILE = join(PAIRING_DIR, "identity.json");
const TRUSTED_PEERS_FILE = join(PAIRING_DIR, "trusted-peers.json");

// ---------------------------------------------------------------------------
// Identity — the bridge's long-term key pair
// ---------------------------------------------------------------------------

export interface SerializedIdentity {
  publicKey: string;   // hex
  privateKey: string;  // hex
  createdAt: string;   // ISO-8601
}

export function loadOrCreateIdentity(): KeyPair {
  if (existsSync(IDENTITY_FILE)) {
    return loadIdentity();
  }
  return createAndSaveIdentity();
}

function loadIdentity(): KeyPair {
  const data: SerializedIdentity = JSON.parse(readFileSync(IDENTITY_FILE, "utf8"));
  return {
    publicKey: hexToBytes(data.publicKey),
    privateKey: hexToBytes(data.privateKey),
  };
}

function createAndSaveIdentity(): KeyPair {
  const keyPair = generateKeyPair();
  mkdirSync(PAIRING_DIR, { recursive: true });

  const data: SerializedIdentity = {
    publicKey: bytesToHex(keyPair.publicKey),
    privateKey: bytesToHex(keyPair.privateKey),
    createdAt: new Date().toISOString(),
  };

  writeFileSync(IDENTITY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  return keyPair;
}

// ---------------------------------------------------------------------------
// Trusted peers — phones that have completed a handshake
// ---------------------------------------------------------------------------

export interface TrustedPeer {
  publicKey: string;   // hex
  name?: string;
  pairedAt: string;    // ISO-8601
  lastSeen?: string;
}

export function loadTrustedPeers(): Map<string, TrustedPeer> {
  if (!existsSync(TRUSTED_PEERS_FILE)) return new Map();
  const data: TrustedPeer[] = JSON.parse(readFileSync(TRUSTED_PEERS_FILE, "utf8"));
  return new Map(data.map((p) => [p.publicKey, p]));
}

export function saveTrustedPeer(peer: TrustedPeer): void {
  const peers = loadTrustedPeers();
  peers.set(peer.publicKey, peer);
  mkdirSync(PAIRING_DIR, { recursive: true });
  writeFileSync(TRUSTED_PEERS_FILE, JSON.stringify([...peers.values()], null, 2), { mode: 0o600 });
}

export function isTrustedPeer(publicKeyHex: string): boolean {
  return loadTrustedPeers().has(publicKeyHex);
}

// ---------------------------------------------------------------------------
// QR pairing payload — everything the phone needs to connect
// ---------------------------------------------------------------------------

export interface QRPayload {
  /** Protocol version. */
  v: number;
  /** Relay WebSocket URL. */
  relay: string;
  /** Additional relay URLs the phone should try after the primary relay. */
  fallbackRelays?: string[];
  /** Room ID on the relay. */
  room: string;
  /** Bridge's static public key (hex). */
  publicKey: string;
  /** Expiry timestamp (ms since epoch). */
  expiresAt: number;
}

const QR_VERSION = 1;
const QR_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export function createQRPayload(
  bridgePublicKey: Uint8Array,
  relayUrl: string,
  fallbackRelayUrls: string[] = [],
): QRPayload {
  const fallbackRelays = normalizedRelayUrls(fallbackRelayUrls, relayUrl);
  return {
    v: QR_VERSION,
    relay: relayUrl,
    ...(fallbackRelays.length > 0 ? { fallbackRelays } : {}),
    room: crypto.randomUUID(),
    publicKey: bytesToHex(bridgePublicKey),
    expiresAt: Date.now() + QR_EXPIRY_MS,
  };
}

export function validateQRPayload(payload: QRPayload): boolean {
  if (payload.v !== QR_VERSION) return false;
  if (Date.now() > payload.expiresAt) return false;
  if (!payload.relay || !payload.room || !payload.publicKey) return false;
  return true;
}

function normalizedRelayUrls(urls: string[], primaryRelayUrl: string): string[] {
  const seen = new Set([primaryRelayUrl.trim()]);
  const normalized: string[] = [];

  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
