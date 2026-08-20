import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";

import {
  assertTestIsolatedUserData,
  resolveOpenScoutSupportPaths,
} from "./support-paths.js";

/**
 * Mesh trust cone P1.5 (docs/proposals/mesh-trust-cone.md §11.1): every node
 * owns a SEPARATE long-lived keypair that terminates TLS — the node identity
 * key (still Ed25519; it signs node cards and never terminates TLS) never
 * does. Only the self-signed certificate is re-issued (expiry/hygiene); the
 * key is retained for the life of the node, so the SPKI fingerprint peers pin
 * (§11.2) never changes from routine renewal. The private key never leaves
 * the support directory.
 *
 * On disk (`node-tls-identity.json`, mode 0600): TLS private key (pkcs8 DER
 * base64), current cert (DER base64), `notAfter`. Written exclusive-first and
 * atomically (tmp + rename on renewal) with the same load-validate discipline
 * as `loadOrCreateNodeIdentity`.
 */

export const NODE_TLS_IDENTITY_FILE = "node-tls-identity.json";
export const TLS_CERT_VALIDITY_MS = 365 * 24 * 60 * 60 * 1_000;
/** Certs are re-issued at boot when fewer than 30 days remain (§11.1). */
export const TLS_CERT_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** Persisted shape of `node-tls-identity.json`. */
export type NodeTlsIdentityFile = {
  version: 1;
  /**
   * base64 DER (pkcs8) TLS private key — never leaves this machine. The
   * algorithm is not stored: it is read back off the key itself, so an
   * identity written by an older build stays loadable (and re-keyable).
   */
  privateKey: string;
  /** base64 DER self-signed X.509 certificate issued from `privateKey` */
  certificate: string;
  /** ms epoch of the certificate's notAfter */
  notAfter: number;
};

export type NodeTlsIdentity = {
  keyPair: {
    publicKey: KeyObject;
    privateKey: KeyObject;
  };
  certificateDer: Buffer;
  certificatePem: string;
  /**
   * SHA-256 of the certificate's SubjectPublicKeyInfo DER as 64 lowercase
   * hex — the value advertised as `tls.spkiFingerprint` on the signed node
   * card and pinned by enrolled peers. Stable across cert re-issuance.
   */
  spkiFingerprint: string;
  notAfter: number;
};

/**
 * TLS keypair algorithm. §11.1 originally specified Ed25519; `ec-p256` exists
 * because Bun's TLS stack (BoringSSL) cannot serve *or* verify an Ed25519 leaf
 * certificate — a Bun listener holding one never completes a handshake, from
 * a Bun *or* a Node client, while Node↔Node with the same cert succeeds. The
 * deployed broker runs under Bun (`#!/usr/bin/env bun`), so a mesh that ships
 * Ed25519 TLS has no working handshake at all.
 *
 * **§11.1 decision (2026-08-10): the default is now `ec-p256`.** Pilot
 * evidence from the two-host mesh (Studio + Air): with an Ed25519 leaf, mesh
 * announce returned 200 and listed TLS endpoints, but every client handshake
 * failed with `sslv3 alert handshake failure`; swapping the same node to a
 * P-256 leaf made `GET https://<lan-ip>:43110/health` complete TLS and return
 * the expected local-only gate response, and the peer host reached it. The
 * "must land before any pin is minted" caveat is discharged by re-keying on
 * mismatch (below) plus re-enrollment — an Ed25519 pin is worthless anyway,
 * since no handshake that would present it can succeed.
 */
export type TlsKeyAlgorithm = "ed25519" | "ec-p256";

/**
 * Algorithm used for a newly generated TLS keypair, and the algorithm an
 * existing identity is re-keyed *to* when it does not match. `ed25519` stays
 * selectable for Node-only callers and for the regression tests that pin the
 * Bun behaviour above.
 */
export const DEFAULT_TLS_KEY_ALGORITHM: TlsKeyAlgorithm = "ec-p256";

export type TlsCertificateOptions = {
  /**
   * The node identity key ID whose first 16 chars name the cert subject/SAN
   * (debuggability only, §11.1 — never used for authorization). Defaults to
   * the SHA-256 key ID of the TLS key itself.
   */
  nodeKeyId?: string;
  /**
   * Algorithm this caller needs to be able to *serve*. Applies both to a
   * newly generated key and to an existing one: a persisted identity whose
   * algorithm differs is re-keyed (see `loadOrCreateTlsIdentity`), because an
   * identity the local TLS stack cannot serve is not repairable by any other
   * means. Defaults to {@link DEFAULT_TLS_KEY_ALGORITHM}.
   */
  algorithm?: TlsKeyAlgorithm;
  now?: number;
};

/** WebCrypto import/sign parameters for a node:crypto TLS keypair. */
function webCryptoAlgorithm(publicKey: KeyObject): {
  importAlgorithm: EcKeyImportParams | Algorithm;
  signingAlgorithm?: EcdsaParams;
} {
  if (publicKey.asymmetricKeyType === "ec") {
    const namedCurve = publicKey.asymmetricKeyDetails?.namedCurve;
    if (namedCurve !== "prime256v1") {
      throw new Error(`unsupported TLS EC curve ${namedCurve ?? "unknown"}; expected prime256v1 (P-256)`);
    }
    return {
      importAlgorithm: { name: "ECDSA", namedCurve: "P-256" },
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    };
  }
  return { importAlgorithm: { name: "Ed25519" } };
}

/**
 * The algorithm of a persisted TLS keypair, or `undefined` when it is neither
 * §11.1 algorithm — an identity this build can neither serve nor renew, which
 * is treated exactly like a mismatch and re-keyed.
 */
function tlsKeyAlgorithm(publicKey: KeyObject): TlsKeyAlgorithm | undefined {
  if (publicKey.asymmetricKeyType === "ed25519") {
    return "ed25519";
  }
  if (
    publicKey.asymmetricKeyType === "ec"
    && publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
  ) {
    return "ec-p256";
  }
  return undefined;
}

function generateTlsKeyPair(algorithm: TlsKeyAlgorithm): { publicKey: KeyObject; privateKey: KeyObject } {
  return algorithm === "ec-p256"
    ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    : generateKeyPairSync("ed25519");
}

export function nodeTlsIdentityPath(supportDirectory?: string): string {
  const dir = supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  return join(dir, NODE_TLS_IDENTITY_FILE);
}

/** The §11.2 pin: SHA-256 hex of a SubjectPublicKeyInfo DER. */
export function tlsSpkiFingerprintFromDer(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex");
}

/**
 * The §11.2 pin computed from a peer's *certificate* DER — the form the
 * pinning client (§11.4) observes on the wire. The pin is over the
 * SubjectPublicKeyInfo, not the certificate, so re-issuance never moves it.
 */
export function tlsSpkiFingerprintFromCertificateDer(certificateDer: Buffer): string {
  const certificate = new X509Certificate(asBufferSource(certificateDer));
  return tlsSpkiFingerprintFromDer(Buffer.from(certificate.publicKey.rawData));
}

/**
 * Copy a Buffer into a fresh ArrayBuffer-backed view: WebCrypto's BufferSource
 * and @peculiar/x509's AsnEncodedType reject Buffer<ArrayBufferLike> typings.
 */
function asBufferSource(der: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(der);
}

/**
 * Load the retained TLS keypair (creating it on first run) and return a valid
 * certificate issued from it. When the persisted certificate has fewer than
 * 30 days left it is re-issued from the SAME key and the file rewritten — the
 * SPKI fingerprint, and every stored pin, is unchanged by renewal (§11.1).
 *
 * The one case that DOES move the SPKI is an algorithm mismatch: if the
 * persisted key is not the algorithm the caller asked to serve, it is
 * re-keyed. Without this, a node that once wrote an Ed25519 identity keeps
 * serving a leaf Bun can never complete a handshake for, forever — renewal
 * alone cannot repair it, because renewal deliberately retains the key.
 * Re-keying invalidates pins peers hold for this node; they must re-enroll.
 */
export async function loadOrCreateTlsIdentity(
  supportDirectory?: string,
  options: TlsCertificateOptions = {},
): Promise<NodeTlsIdentity> {
  const path = nodeTlsIdentityPath(supportDirectory);
  if (!existsSync(path)) {
    return createTlsIdentity(supportDirectory, options);
  }
  const file = readAndValidateTlsIdentity(path);
  const keyPair = tlsKeyPairFromFile(file);
  const wanted = options.algorithm ?? DEFAULT_TLS_KEY_ALGORITHM;
  const persisted = tlsKeyAlgorithm(keyPair.publicKey);
  if (persisted !== wanted) {
    return rekeyTlsIdentity(path, wanted, persisted, options);
  }
  const now = options.now ?? Date.now();
  if (file.notAfter - now > TLS_CERT_RENEWAL_WINDOW_MS) {
    return identityFromParts(keyPair, Buffer.from(file.certificate, "base64"), file.notAfter);
  }
  // Renewal: re-issue the certificate from the retained key.
  const issued = await issueSelfSignedCertificate(keyPair, options);
  persistTlsIdentityFile(path, {
    version: 1,
    privateKey: file.privateKey,
    certificate: issued.der.toString("base64"),
    notAfter: issued.notAfter,
  }, { exclusive: false });
  return identityFromParts(keyPair, issued.der, issued.notAfter);
}

/**
 * Issue a fresh self-signed certificate from an existing TLS keypair (§11.1):
 * Subject/Issuer CN `openscout-node-<first 16 of keyId>`, one SAN DNS entry
 * `node-<first 16 of keyId>.openscout.mesh` (informational — clients never do
 * hostname verification), 128-bit CSPRNG serial, 365-day validity. Exported
 * for renewal paths and tests; the SPKI pin never depends on the result.
 */
export async function issueSelfSignedCertificate(
  keyPair: { publicKey: KeyObject; privateKey: KeyObject },
  options: TlsCertificateOptions = {},
): Promise<{ der: Buffer; pem: string; notAfter: number }> {
  const now = options.now ?? Date.now();
  const spkiDer = keyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const keyId16 = (options.nodeKeyId ?? tlsSpkiFingerprintFromDer(spkiDer)).slice(0, 16);
  const subtle = globalThis.crypto.subtle;
  const { importAlgorithm, signingAlgorithm } = webCryptoAlgorithm(keyPair.publicKey);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: `CN=openscout-node-${keyId16}`,
    notBefore: new Date(now),
    notAfter: new Date(now + TLS_CERT_VALIDITY_MS),
    signingAlgorithm,
    keys: {
      privateKey: await subtle.importKey(
        "pkcs8",
        asBufferSource(keyPair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer),
        importAlgorithm,
        true,
        ["sign"],
      ),
      publicKey: await subtle.importKey("spki", asBufferSource(spkiDer), importAlgorithm, true, ["verify"]),
    },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new SubjectAlternativeNameExtension(
        [{ type: "dns", value: `node-${keyId16}.openscout.mesh` }],
        false,
      ),
    ],
  });
  const der = Buffer.from(cert.rawData);
  return { der, pem: cert.toString("pem"), notAfter: cert.notAfter.getTime() };
}

/**
 * Replace a persisted identity whose key algorithm the caller cannot serve.
 * Overwrites in place (tmp + rename); the exclusive-create guard that protects
 * a concurrent *first* run does not apply, because the key being replaced is
 * by definition one no peer can complete a handshake against.
 */
async function rekeyTlsIdentity(
  path: string,
  algorithm: TlsKeyAlgorithm,
  persisted: TlsKeyAlgorithm | undefined,
  options: TlsCertificateOptions,
): Promise<NodeTlsIdentity> {
  const keyPair = generateTlsKeyPair(algorithm);
  const issued = await issueSelfSignedCertificate(keyPair, options);
  persistTlsIdentityFile(path, {
    version: 1,
    privateKey: (keyPair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
    certificate: issued.der.toString("base64"),
    notAfter: issued.notAfter,
  }, { exclusive: false });
  const identity = identityFromParts(keyPair, issued.der, issued.notAfter);
  console.warn(
    `[openscout-runtime] node TLS identity re-keyed ${persisted ?? "unrecognized"} -> ${algorithm} `
    + `at ${path}: the SPKI fingerprint is now ${identity.spkiFingerprint}. Peers pinned to the `
    + "previous key must re-enroll (scout mesh enroll) before they can reach this node.",
  );
  return identity;
}

async function createTlsIdentity(
  supportDirectory: string | undefined,
  options: TlsCertificateOptions,
): Promise<NodeTlsIdentity> {
  if (!supportDirectory) {
    assertTestIsolatedUserData("write the node TLS identity", "OPENSCOUT_SUPPORT_DIRECTORY");
  }
  const path = nodeTlsIdentityPath(supportDirectory);
  const { publicKey, privateKey } = generateTlsKeyPair(options.algorithm ?? DEFAULT_TLS_KEY_ALGORITHM);
  const keyPair = { publicKey, privateKey };
  const issued = await issueSelfSignedCertificate(keyPair, options);
  const file: NodeTlsIdentityFile = {
    version: 1,
    privateKey: (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"),
    certificate: issued.der.toString("base64"),
    notAfter: issued.notAfter,
  };
  try {
    // Exclusive create: a concurrent first-run can never replace a TLS key
    // another process already started advertising a pin for.
    persistTlsIdentityFile(path, file, { exclusive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the first-run race: adopt the winner's identity, but hold it to
      // the same algorithm rule as the load path — a key we cannot serve is
      // no more usable for having been written by another process.
      const existing = readAndValidateTlsIdentity(path);
      const existingKeyPair = tlsKeyPairFromFile(existing);
      const wanted = options.algorithm ?? DEFAULT_TLS_KEY_ALGORITHM;
      const persisted = tlsKeyAlgorithm(existingKeyPair.publicKey);
      if (persisted !== wanted) {
        return rekeyTlsIdentity(path, wanted, persisted, options);
      }
      return identityFromParts(
        existingKeyPair,
        Buffer.from(existing.certificate, "base64"),
        existing.notAfter,
      );
    }
    throw error;
  }
  return identityFromParts(keyPair, issued.der, issued.notAfter);
}

function readAndValidateTlsIdentity(path: string): NodeTlsIdentityFile {
  let parsed: NodeTlsIdentityFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as NodeTlsIdentityFile;
  } catch {
    throw new Error(`Corrupt node TLS identity at ${path}; remove it to generate a fresh one.`);
  }
  if (
    parsed.version !== 1
    || !parsed.privateKey
    || !parsed.certificate
    || !Number.isFinite(parsed.notAfter)
  ) {
    throw new Error(`Corrupt node TLS identity at ${path}; remove it to generate a fresh one.`);
  }
  // Verify the pair: the certificate's SPKI must be the private key's SPKI —
  // otherwise the file pins a key this node can no longer serve.
  try {
    const derived = createPublicKey(createPrivateKey({
      key: Buffer.from(parsed.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    })).export({ type: "spki", format: "der" }) as Buffer;
    const certificate = new X509Certificate(asBufferSource(Buffer.from(parsed.certificate, "base64")));
    if (!Buffer.from(certificate.publicKey.rawData).equals(derived)) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(
      `Node TLS identity at ${path} has a mismatched or invalid key/certificate; remove it to generate a fresh one.`,
    );
  }
  return parsed;
}

function tlsKeyPairFromFile(file: NodeTlsIdentityFile): { publicKey: KeyObject; privateKey: KeyObject } {
  const privateKey = createPrivateKey({
    key: Buffer.from(file.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return { publicKey: createPublicKey(privateKey), privateKey };
}

function identityFromParts(
  keyPair: { publicKey: KeyObject; privateKey: KeyObject },
  certificateDer: Buffer,
  notAfter: number,
): NodeTlsIdentity {
  const spkiDer = keyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    keyPair,
    certificateDer,
    certificatePem: new X509Certificate(asBufferSource(certificateDer)).toString("pem"),
    spkiFingerprint: tlsSpkiFingerprintFromDer(spkiDer),
    notAfter,
  };
}

function persistTlsIdentityFile(
  path: string,
  file: NodeTlsIdentityFile,
  { exclusive }: { exclusive: boolean },
): void {
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(file, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } else {
    // Renewal overwrite: tmp + rename so a crash mid-write never leaves a
    // truncated identity behind.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort; mode on create already restrictive
  }
}
