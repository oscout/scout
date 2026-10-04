import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { canonicalJson, nodeKeyId, type NodeIdentity } from "./node-identity.js";
import {
  PeerNonceCache, scopedPeerRequestSigningPayload, sha256Hex,
  signPeerRequest, signScopedPeerRequest, verifyPeerRequest, verifyScopedPeerRequest,
  type VerifyPeerRequestInput,
} from "./mesh-peer-auth.js";
import { ACCESS_PROTOCOL, signAccessArtifact, type AccessDelegation } from "./mesh-access.js";

function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { version: 1, createdAt: 1, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}
const now = 2_000_000;
function fixture() {
  const person = identity(), device = identity();
  const delegation = signAccessArtifact<AccessDelegation>(person, {
    protocol: ACCESS_PROTOCOL, kind: "delegation", id: "delegation-1", networkId: nodeKeyId(person.publicKey),
    principalId: nodeKeyId(person.publicKey), devicePublicKey: device.publicKey, audience: "a".repeat(64),
    issuedAt: now - 1000, expiresAt: now + 1000, scope: { all: false, agentIds: ["agent:one"], projectIds: [] }, actions: ["discover"],
  });
  const request = { method: "POST", path: "/v1/access/rpc", body: JSON.stringify({ delegation, operation: "discover" }), destinationKeyId: delegation.audience, ts: now, nonce: "test-nonce" };
  const headers = (signed: Record<string, string>) => ({ peer: signed["x-openscout-peer"], ts: signed["x-openscout-ts"], nonce: signed["x-openscout-nonce"], signature: signed["x-openscout-signature"] });
  const input: VerifyPeerRequestInput & { delegation: AccessDelegation } = {
    ...request, delegation, headers: headers(signScopedPeerRequest(device, { ...request, delegation })),
    lookupPeer: (id) => id === nodeKeyId(device.publicKey) ? { publicKey: device.publicKey, tier: "observe" } : undefined,
    nonceClaim: new PeerNonceCache(), now, bootedAt: now - 10_000,
  };
  return { person, device, delegation, request, headers, input };
}

describe("scoped request signature v2", () => {
  test("canonical payload explicitly binds scoped domain, network, principal and exact delegation", () => {
    const f = fixture();
    const hash = sha256Hex(canonicalJson(f.delegation));
    expect(scopedPeerRequestSigningPayload({ ...f.request, bodySha256Hex: sha256Hex(f.request.body), networkId: f.delegation.networkId, principalId: f.delegation.principalId, delegationHash: hash }).split("\n")).toEqual([
      "v2-scoped", "POST", "/v1/access/rpc", sha256Hex(f.request.body), f.delegation.audience, String(now), "test-nonce", f.delegation.networkId, f.delegation.principalId, hash,
    ]);
    expect(verifyScopedPeerRequest(f.input).ok).toBe(true);
    expect(verifyScopedPeerRequest(f.input)).toEqual({ ok: false, reason: "nonce replay" });
  });
  test("v1 and scoped v2 signatures cannot cross authentication domains", () => {
    const f = fixture();
    expect(verifyScopedPeerRequest({ ...f.input, headers: f.headers(signPeerRequest(f.device, f.request)) })).toEqual({ ok: false, reason: "invalid signature" });
    expect(verifyPeerRequest(f.input)).toEqual({ ok: false, reason: "invalid signature" });
    expect(verifyScopedPeerRequest(f.input).ok).toBe(true);
  });
  test("delegation substitution, network/principal, audience, body, method, and path tampering fail", () => {
    const f = fixture();
    const variants = [
      { delegation: { ...f.delegation, id: "another-certificate" } },
      { delegation: { ...f.delegation, networkId: "b".repeat(64) } },
      { delegation: { ...f.delegation, principalId: "b".repeat(64) } },
      { delegation: { ...f.delegation, signature: "changed" } },
      { destinationKeyId: "b".repeat(64) }, { body: f.request.body + " " }, { method: "GET" }, { path: "/v1/access/admin" },
    ];
    for (const variant of variants) expect(verifyScopedPeerRequest({ ...f.input, ...variant })).toEqual({ ok: false, reason: "invalid signature" });
    expect(verifyScopedPeerRequest(f.input).ok).toBe(true);
  });
  test("timestamp bounds, boot cutoff, missing headers and malformed context fail without claiming a nonce", () => {
    const f = fixture();
    let claims = 0;
    const input = { ...f.input, nonceClaim: { claim: () => { claims++; return true; } } };
    expect(verifyScopedPeerRequest({ ...input, now: now + 400_000 }).ok).toBe(false);
    expect(verifyScopedPeerRequest({ ...input, bootedAt: now + 20_000 }).ok).toBe(false);
    expect(verifyScopedPeerRequest({ ...input, headers: {} }).ok).toBe(false);
    expect(verifyScopedPeerRequest({ ...input, delegation: { ...f.delegation, networkId: "bad\ncontext" } })).toEqual({ ok: false, reason: "malformed signing components" });
    expect(claims).toBe(0);
  });
});
