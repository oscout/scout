import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { X509Certificate } from "@peculiar/x509";

import {
  DEFAULT_TLS_KEY_ALGORITHM,
  issueSelfSignedCertificate,
  loadOrCreateTlsIdentity,
  NODE_TLS_IDENTITY_FILE,
  TLS_CERT_RENEWAL_WINDOW_MS,
  TLS_CERT_VALIDITY_MS,
  tlsSpkiFingerprintFromDer,
} from "./node-tls-identity.js";

function tempSupportDirectory(): string {
  return mkdtempSync(join(tmpdir(), "openscout-node-tls-identity-test-"));
}

function storedFile(dir: string) {
  return JSON.parse(readFileSync(join(dir, NODE_TLS_IDENTITY_FILE), "utf8")) as {
    version: number;
    privateKey: string;
    certificate: string;
    notAfter: number;
  };
}

/** Read the algorithm back off the persisted private key, as production does. */
function storedKeyAlgorithm(dir: string): { type: string | null; curve: string | undefined } {
  const publicKey = createPublicKey(createPrivateKey({
    key: Buffer.from(storedFile(dir).privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  }));
  return {
    type: publicKey.asymmetricKeyType ?? null,
    curve: publicKey.asymmetricKeyDetails?.namedCurve,
  };
}

describe("node TLS identity (mesh-trust-cone §11.1)", () => {
  test("creates and persists a separate P-256 keypair + self-signed cert, mode 0600", async () => {
    const dir = tempSupportDirectory();
    const identity = await loadOrCreateTlsIdentity(dir);
    expect(storedKeyAlgorithm(dir)).toEqual({ type: "ec", curve: "prime256v1" });
    expect(identity.spkiFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.certificateDer.length).toBeGreaterThan(0);
    expect(identity.certificatePem.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(identity.notAfter).toBeGreaterThan(Date.now());

    const mode = statSync(join(dir, NODE_TLS_IDENTITY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);

    const file = storedFile(dir);
    expect(Object.keys(file).sort()).toEqual(["certificate", "notAfter", "privateKey", "version"]);
    expect(file.version).toBe(1);

    // Reload: same key, same cert, same pin — nothing is regenerated.
    const reloaded = await loadOrCreateTlsIdentity(dir);
    expect(reloaded.spkiFingerprint).toBe(identity.spkiFingerprint);
    expect(reloaded.certificateDer.equals(identity.certificateDer)).toBe(true);
    expect(storedFile(dir).privateKey).toBe(file.privateKey);
  });

  test("a second node gets a different key and pin", async () => {
    const one = await loadOrCreateTlsIdentity(tempSupportDirectory());
    const two = await loadOrCreateTlsIdentity(tempSupportDirectory());
    expect(two.spkiFingerprint).not.toBe(one.spkiFingerprint);
  });

  test("the pin is the SHA-256 of the certificate's SubjectPublicKeyInfo DER", async () => {
    const identity = await loadOrCreateTlsIdentity(tempSupportDirectory());
    const certificate = new X509Certificate(identity.certificateDer);
    const certSpki = Buffer.from(certificate.publicKey.rawData);
    expect(tlsSpkiFingerprintFromDer(certSpki)).toBe(identity.spkiFingerprint);
    // ...and NOT a fingerprint of the certificate itself: renewal must keep it.
    const certDerFingerprint = createHash("sha256").update(identity.certificateDer).digest("hex");
    expect(identity.spkiFingerprint).not.toBe(certDerFingerprint);
  });

  test("cert subject/SAN follow §11.1", async () => {
    const nodeKeyId = "ab".repeat(32);
    const identity = await loadOrCreateTlsIdentity(tempSupportDirectory(), { nodeKeyId });
    const certificate = new X509Certificate(identity.certificateDer);
    expect(certificate.subject).toContain(`CN=openscout-node-${nodeKeyId.slice(0, 16)}`);
    expect(certificate.issuer).toBe(certificate.subject);
    const san = certificate.extensions
      .map((extension) => extension.toString())
      .join("\n");
    expect(san).toContain(`node-${nodeKeyId.slice(0, 16)}.openscout.mesh`);
  });

  test("cert validity is ~365 days from issuance", async () => {
    const before = Date.now();
    const identity = await loadOrCreateTlsIdentity(tempSupportDirectory());
    expect(identity.notAfter).toBeGreaterThanOrEqual(before + TLS_CERT_VALIDITY_MS - 5_000);
    expect(identity.notAfter).toBeLessThanOrEqual(Date.now() + TLS_CERT_VALIDITY_MS + 5_000);
  });

  test("renewal inside the 30-day window re-issues the cert from the SAME key: pin stable, DER changes", async () => {
    const dir = tempSupportDirectory();
    const identity = await loadOrCreateTlsIdentity(dir);
    const before = storedFile(dir);

    // Forge an imminent expiry: the renewal decision reads the stored notAfter.
    writeFileSync(
      join(dir, NODE_TLS_IDENTITY_FILE),
      `${JSON.stringify({ ...before, notAfter: Date.now() + TLS_CERT_RENEWAL_WINDOW_MS - 1_000 }, null, 2)}\n`,
      "utf8",
    );

    const renewed = await loadOrCreateTlsIdentity(dir);
    expect(renewed.spkiFingerprint).toBe(identity.spkiFingerprint);
    expect(renewed.certificateDer.equals(identity.certificateDer)).toBe(false);
    expect(renewed.notAfter).toBeGreaterThan(Date.now() + TLS_CERT_VALIDITY_MS - 5_000);

    const after = storedFile(dir);
    expect(after.privateKey).toBe(before.privateKey);
    expect(after.certificate).not.toBe(before.certificate);
    expect(after.notAfter).toBe(renewed.notAfter);
  });

  test("no renewal while plenty of validity remains", async () => {
    const dir = tempSupportDirectory();
    const identity = await loadOrCreateTlsIdentity(dir);
    const reloaded = await loadOrCreateTlsIdentity(dir, { now: Date.now() + TLS_CERT_VALIDITY_MS - TLS_CERT_RENEWAL_WINDOW_MS - 60_000 });
    expect(reloaded.certificateDer.equals(identity.certificateDer)).toBe(true);
  });

  test("re-issuing a cert from the same keypair keeps the SPKI pin and changes the serial", async () => {
    const dir = tempSupportDirectory();
    const identity = await loadOrCreateTlsIdentity(dir);
    const reissued = await issueSelfSignedCertificate(identity.keyPair);
    expect(reissued.der.equals(identity.certificateDer)).toBe(false);
    const reissuedSpki = Buffer.from(new X509Certificate(reissued.der).publicKey.rawData);
    expect(tlsSpkiFingerprintFromDer(reissuedSpki)).toBe(identity.spkiFingerprint);
  });

  test("the default algorithm is ec-p256 (Bun cannot serve an Ed25519 leaf — §11.1 amendment)", () => {
    expect(DEFAULT_TLS_KEY_ALGORITHM).toBe("ec-p256");
  });

  test("ed25519 stays selectable for callers that ask for it", async () => {
    const dir = tempSupportDirectory();
    await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519" });
    expect(storedKeyAlgorithm(dir)).toEqual({ type: "ed25519", curve: undefined });
  });

  test("re-keys a persisted identity whose algorithm does not match the requested one", async () => {
    const dir = tempSupportDirectory();
    // An identity written by a pre-amendment build: Ed25519, unserveable by Bun.
    const legacy = await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519" });
    const legacyFile = storedFile(dir);
    expect(storedKeyAlgorithm(dir).type).toBe("ed25519");

    // The mesh listener asks for what it can actually serve.
    const rekeyed = await loadOrCreateTlsIdentity(dir, { algorithm: "ec-p256" });

    expect(storedKeyAlgorithm(dir)).toEqual({ type: "ec", curve: "prime256v1" });
    // Re-keying is the one path that moves the pin: peers must re-enroll.
    expect(rekeyed.spkiFingerprint).not.toBe(legacy.spkiFingerprint);
    // The unserveable key is gone from disk, not merely shadowed.
    const after = storedFile(dir);
    expect(after.privateKey).not.toBe(legacyFile.privateKey);
    expect(after.certificate).not.toBe(legacyFile.certificate);
    expect(after.version).toBe(1);
    // The returned identity is the one now persisted.
    const persistedSpki = Buffer.from(
      new X509Certificate(Buffer.from(after.certificate, "base64")).publicKey.rawData,
    );
    expect(tlsSpkiFingerprintFromDer(persistedSpki)).toBe(rekeyed.spkiFingerprint);
  });

  test("an Ed25519 identity is re-keyed by a caller that passes no algorithm at all", async () => {
    const dir = tempSupportDirectory();
    const legacy = await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519" });
    const adopted = await loadOrCreateTlsIdentity(dir);
    expect(storedKeyAlgorithm(dir)).toEqual({ type: "ec", curve: "prime256v1" });
    expect(adopted.spkiFingerprint).not.toBe(legacy.spkiFingerprint);
  });

  test("a matching algorithm never re-keys — the pin survives reload", async () => {
    const dir = tempSupportDirectory();
    const first = await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519" });
    const second = await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519" });
    expect(second.spkiFingerprint).toBe(first.spkiFingerprint);
    expect(storedKeyAlgorithm(dir).type).toBe("ed25519");
  });

  test("re-key still honours nodeKeyId and the renewal clock", async () => {
    const dir = tempSupportDirectory();
    const nodeKeyId = "cd".repeat(32);
    await loadOrCreateTlsIdentity(dir, { algorithm: "ed25519", nodeKeyId });
    const rekeyed = await loadOrCreateTlsIdentity(dir, { algorithm: "ec-p256", nodeKeyId });
    const certificate = new X509Certificate(rekeyed.certificateDer);
    expect(certificate.subject).toContain(`CN=openscout-node-${nodeKeyId.slice(0, 16)}`);
    expect(rekeyed.notAfter).toBeGreaterThan(Date.now() + TLS_CERT_VALIDITY_MS - 5_000);
  });

  test("refuses a corrupt TLS identity file", async () => {
    const dir = tempSupportDirectory();
    writeFileSync(join(dir, NODE_TLS_IDENTITY_FILE), '{"version":2}\n', "utf8");
    await expect(loadOrCreateTlsIdentity(dir)).rejects.toThrow(/Corrupt node TLS identity/);
  });

  test("refuses a file whose certificate does not match the private key", async () => {
    const dirA = tempSupportDirectory();
    const dirB = tempSupportDirectory();
    await loadOrCreateTlsIdentity(dirA);
    await loadOrCreateTlsIdentity(dirB);
    const a = storedFile(dirA);
    const b = storedFile(dirB);
    writeFileSync(
      join(dirA, NODE_TLS_IDENTITY_FILE),
      `${JSON.stringify({ ...a, certificate: b.certificate }, null, 2)}\n`,
      "utf8",
    );
    await expect(loadOrCreateTlsIdentity(dirA)).rejects.toThrow(/mismatched or invalid/);
  });
});
