import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PeerNonceCache,
  peerRequestSigningPayload,
  signPeerRequest,
  verifyPeerRequest,
  type PeerAuthLookup,
} from "./mesh-peer-auth.js";
import { loadOrCreateNodeIdentity, nodeKeyId } from "./node-identity.js";

function freshIdentity() {
  return loadOrCreateNodeIdentity(mkdtempSync(join(tmpdir(), "openscout-peer-auth-test-")));
}

const DEST = "a".repeat(64);

function lookupFor(publicKey: string, tier: "observe" | "control" = "observe"): PeerAuthLookup {
  return () => ({ publicKey, tier });
}

function headerValues(headers: Record<string, string>) {
  return {
    peer: headers["x-openscout-peer"],
    ts: headers["x-openscout-ts"],
    nonce: headers["x-openscout-nonce"],
    signature: headers["x-openscout-signature"],
  };
}

describe("peer request signing", () => {
  test("round-trips a signed request", () => {
    const identity = freshIdentity();
    const headers = signPeerRequest(identity, {
      method: "post",
      path: "/v1/messages?limit=10",
      body: '{"hello":"mesh"}',
      destinationKeyId: DEST,
    });
    const result = verifyPeerRequest({
      method: "POST",
      path: "/v1/messages?limit=10",
      body: '{"hello":"mesh"}',
      headers: headerValues(headers),
      destinationKeyId: DEST,
      lookupPeer: lookupFor(identity.publicKey, "control"),
      nonceClaim: new PeerNonceCache(),
      bootedAt: Date.now() - 60_000,
    });
    expect(result).toEqual({
      ok: true,
      principal: { keyId: nodeKeyId(identity.publicKey), tier: "control" },
    });
  });

  test("rejects missing headers, unknown peers, tampered bodies, wrong destination", () => {
    const identity = freshIdentity();
    const headers = signPeerRequest(identity, {
      method: "POST",
      path: "/v1/messages",
      body: "abc",
      destinationKeyId: DEST,
    });
    const base = {
      method: "POST",
      path: "/v1/messages",
      body: "abc",
      headers: headerValues(headers),
      destinationKeyId: DEST,
      lookupPeer: lookupFor(identity.publicKey),
      nonceClaim: new PeerNonceCache(),
      bootedAt: Date.now() - 60_000,
    };

    const missing = verifyPeerRequest({ ...base, headers: {} });
    expect(missing.ok).toBe(false);

    const unknownPeer = verifyPeerRequest({ ...base, lookupPeer: () => undefined });
    expect(unknownPeer.ok).toBe(false);
    if (!unknownPeer.ok) expect(unknownPeer.reason).toMatch(/not enrolled/);

    const tamperedBody = verifyPeerRequest({ ...base, body: "abc!" });
    expect(tamperedBody.ok).toBe(false);

    const wrongDestination = verifyPeerRequest({
      ...base,
      destinationKeyId: "b".repeat(64),
    });
    expect(wrongDestination.ok).toBe(false);
    if (!wrongDestination.ok) expect(wrongDestination.reason).toMatch(/invalid signature/);
  });

  test("rejects replayed nonces and stale or pre-boot timestamps", () => {
    const identity = freshIdentity();
    const now = Date.now();
    const headers = signPeerRequest(identity, {
      method: "GET",
      path: "/v1/sessions",
      destinationKeyId: DEST,
      ts: now,
    });
    const cache = new PeerNonceCache();
    const base = {
      method: "GET",
      path: "/v1/sessions",
      headers: headerValues(headers),
      destinationKeyId: DEST,
      lookupPeer: lookupFor(identity.publicKey),
      nonceClaim: cache,
      bootedAt: now - 60_000,
      now,
    };

    expect(verifyPeerRequest(base).ok).toBe(true);
    const replay = verifyPeerRequest(base);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toMatch(/replay/);

    const stale = signPeerRequest(identity, {
      method: "GET",
      path: "/v1/sessions",
      destinationKeyId: DEST,
      ts: now - 10 * 60_000,
    });
    expect(verifyPeerRequest({ ...base, headers: headerValues(stale) }).ok).toBe(false);

    const preBoot = signPeerRequest(identity, {
      method: "GET",
      path: "/v1/sessions",
      destinationKeyId: DEST,
      ts: now - 4 * 60_000,
    });
    const preBootResult = verifyPeerRequest({
      ...base,
      headers: headerValues(preBoot),
      bootedAt: now - 60_000, // signed 4m ago, broker booted 1m ago
    });
    expect(preBootResult.ok).toBe(false);
    if (!preBootResult.ok) expect(preBootResult.reason).toMatch(/predates broker boot/);
  });

  test("signing payload rejects newline smuggling", () => {
    expect(() => peerRequestSigningPayload({
      method: "GET",
      path: "/v1/x\ninjected: y",
      bodySha256Hex: "00",
      destinationKeyId: DEST,
      ts: 1,
      nonce: "n",
    })).toThrow(/newlines/);
  });

  test("query string is part of the signature", () => {
    const identity = freshIdentity();
    const headers = signPeerRequest(identity, {
      method: "GET",
      path: "/v1/messages?limit=10",
      destinationKeyId: DEST,
    });
    const result = verifyPeerRequest({
      method: "GET",
      path: "/v1/messages?limit=9999",
      headers: headerValues(headers),
      destinationKeyId: DEST,
      lookupPeer: lookupFor(identity.publicKey),
      nonceClaim: new PeerNonceCache(),
      bootedAt: Date.now() - 60_000,
    });
    expect(result.ok).toBe(false);
  });
});
