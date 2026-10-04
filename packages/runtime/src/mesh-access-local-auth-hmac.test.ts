import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { LOCAL_ADMIN_HEADER, LOCAL_ADMIN_HEADERS, signLocalAdminRequest, verifyLocalAdminRequest } from "./mesh-access-local-auth.js";
import { PeerNonceCache, PEER_AUTH_MAX_SKEW_MS, PRE_BOOT_GRACE_MS, peerRequestSigningPayload, sha256Hex } from "./mesh-peer-auth.js";
const key = "a1".repeat(32), now = 1_000_000, destinationKeyId = "b".repeat(64);
const request = { method: "POST", path: "/v1/access/admin?mode=local", body: '{"operation":"status"}', destinationKeyId, ts: now, nonce: "0123456789abcdef" };
function fixture() {
  return { ...request, headers: signLocalAdminRequest(key, request), now, bootedAt: now - 1000, nonceClaim: new PeerNonceCache() };
}
describe("local administration request HMAC", () => {
  test("key never appears in proof; method/path/body/destination/freshness are authenticated", () => {
    const input = fixture();
    expect(JSON.stringify(input.headers)).not.toContain(key);
    expect(input.headers[LOCAL_ADMIN_HEADER]).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyLocalAdminRequest(key, input)).toEqual({ ok: true });
    expect(verifyLocalAdminRequest(key, input)).toEqual({ ok: false, reason: "local administration nonce replay" });
  });
  test("rejects captured proof with changed action, body, destination, timestamp, or nonce", () => {
    const input = fixture();
    const variants = [
      { method: "GET" }, { path: "/v1/access/admin" }, { body: '{"operation":"revoke"}' }, { destinationKeyId: "c".repeat(64) },
      { headers: { ...input.headers, [LOCAL_ADMIN_HEADERS.ts]: String(now + 1) } },
      { headers: { ...input.headers, [LOCAL_ADMIN_HEADERS.nonce]: "different-nonce-123" } },
    ];
    for (const variant of variants) expect(verifyLocalAdminRequest(key, { ...input, ...variant }).ok).toBe(false);
    expect(verifyLocalAdminRequest("c1".repeat(32), input).ok).toBe(false);
    expect(verifyLocalAdminRequest(key, input).ok).toBe(true);
  });
  test("domain separation and local-admin nonce namespace prevent cross-protocol reuse", () => {
    const input = fixture();
    const legacy = createHmac("sha256", Buffer.from(key, "hex")).update(peerRequestSigningPayload({ ...request, bodySha256Hex: sha256Hex(request.body) })).digest("hex");
    expect(verifyLocalAdminRequest(key, { ...input, headers: { ...input.headers, [LOCAL_ADMIN_HEADER]: legacy } }).ok).toBe(false);
    const claims: string[] = [];
    expect(verifyLocalAdminRequest(key, { ...input, nonceClaim: { claim: (id) => { claims.push(id); return true; } } }).ok).toBe(true);
    expect(claims).toEqual([`local-admin:${destinationKeyId}`]);
  });
  test("missing/malformed/static bearer values never authenticate and never claim nonces", () => {
    const input = fixture();
    let claims = 0;
    for (const mac of [key, "é".repeat(64), "bad", [key], undefined]) {
      expect(verifyLocalAdminRequest(key, { ...input, headers: { ...input.headers, [LOCAL_ADMIN_HEADER]: mac }, nonceClaim: { claim: () => { claims++; return true; } } }).ok).toBe(false);
    }
    expect(verifyLocalAdminRequest(key, { ...input, headers: { [LOCAL_ADMIN_HEADER]: key } }).ok).toBe(false);
    expect(claims).toBe(0);
  });
  test("skew and restart bounds reject stale captured proofs without consuming a nonce", () => {
    const input = fixture();
    expect(verifyLocalAdminRequest(key, { ...input, now: now + PEER_AUTH_MAX_SKEW_MS + 1 }).ok).toBe(false);
    expect(verifyLocalAdminRequest(key, { ...input, now: now - PEER_AUTH_MAX_SKEW_MS - 1 }).ok).toBe(false);
    expect(verifyLocalAdminRequest(key, { ...input, bootedAt: now + PRE_BOOT_GRACE_MS + 1 }).ok).toBe(false);
    expect(verifyLocalAdminRequest(key, { ...input, headers: { ...input.headers, [LOCAL_ADMIN_HEADERS.ts]: "Infinity" } }).ok).toBe(false);
    expect(verifyLocalAdminRequest(key, input).ok).toBe(true);
  });
  test("signer rejects malformed secrets, ambiguous fields, and weak supplied nonces", () => {
    expect(() => signLocalAdminRequest("bad", request)).toThrow();
    expect(() => signLocalAdminRequest(key, { ...request, path: "/one\n/two" })).toThrow();
    expect(() => signLocalAdminRequest(key, { ...request, nonce: "short" })).toThrow();
    expect(() => signLocalAdminRequest(key, { ...request, ts: NaN })).toThrow();
  });
});
