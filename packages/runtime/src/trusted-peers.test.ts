import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrustedPeerRecord } from "@openscout/protocol";

import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const dbRoots = new Set<string>();
let lastDbFile = "";

function dbFileOf(): string {
  return lastDbFile;
}

afterEach(() => {
  for (const root of dbRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  dbRoots.clear();
});

function createStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-trusted-peers-"));
  dbRoots.add(root);
  lastDbFile = join(root, "control-plane.sqlite");
  return new SQLiteControlPlaneStore(lastDbFile);
}

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const KEY_MISSING = "f".repeat(64);

function peer(overrides: Partial<TrustedPeerRecord> = {}): TrustedPeerRecord {
  return {
    keyId: KEY_A,
    publicKey: "b64der-spki-ed25519",
    fingerprint: "osc1:aaaa-bbbb",
    nodeId: "node-remote-1",
    label: "Air",
    tier: "control",
    grantedVia: "sas",
    grantedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("trusted peers store", () => {
  test("upsert and lookup round-trip", () => {
    const store = createStore();
    store.upsertTrustedPeer(
      peer({
        expiresAt: 1_800_000_000_000,
        lastSeenAt: 1_700_000_100_000,
        metadata: { note: "desk machine" },
      }),
    );

    const found = store.trustedPeer(KEY_A);
    expect(found).toEqual({
      keyId: KEY_A,
      publicKey: "b64der-spki-ed25519",
      fingerprint: "osc1:aaaa-bbbb",
      nodeId: "node-remote-1",
      label: "Air",
      tier: "control",
      grantedVia: "sas",
      grantedAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
      revokedAt: undefined,
      lastSeenAt: 1_700_000_100_000,
      metadata: { note: "desk machine" },
    });
    expect(store.trustedPeer(KEY_MISSING)).toBeUndefined();
  });

  test("listTrustedPeers returns non-revoked peers ordered by label", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer({ keyId: KEY_C, fingerprint: "osc1:cccc-dddd", label: "Zephyr" }));
    store.upsertTrustedPeer(peer({ keyId: KEY_A, fingerprint: "osc1:aaaa-bbbb", label: "Air" }));
    store.upsertTrustedPeer(
      peer({ keyId: KEY_B, fingerprint: "osc1:eeee-ffff", label: "Mini", revokedAt: Date.now() }),
    );

    const labels = store.listTrustedPeers().map((record) => record.label);
    expect(labels).toEqual(["Air", "Zephyr"]);
  });

  test("revoke soft-deletes and re-grant works", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer());

    const at = Date.now();
    expect(store.revokeTrustedPeer(KEY_A, at)).toBe(true);
    expect(store.revokeTrustedPeer(KEY_A, at)).toBe(false);
    expect(store.revokeTrustedPeer(KEY_MISSING, at)).toBe(false);

    expect(store.trustedPeer(KEY_A)).toBeUndefined();
    expect(store.listTrustedPeers()).toEqual([]);

    store.upsertTrustedPeer(peer({ grantedAt: at + 1, grantedVia: "ssh" }));
    const regranted = store.trustedPeer(KEY_A);
    expect(regranted).toBeDefined();
    expect(regranted?.grantedVia).toBe("ssh");
    expect(regranted?.revokedAt).toBeUndefined();
  });

  test("expired peers are excluded from lookups like revoked ones", () => {
    const store = createStore();
    const now = Date.now();
    store.upsertTrustedPeer(peer({ keyId: KEY_A, fingerprint: "osc1:aaaa-bbbb", expiresAt: now - 1 }));
    store.upsertTrustedPeer(
      peer({ keyId: KEY_B, fingerprint: "osc1:cccc-dddd", label: "Valid", expiresAt: now + 60_000 }),
    );
    store.upsertTrustedPeer(peer({ keyId: KEY_C, fingerprint: "osc1:eeee-ffff", label: "No expiry" }));

    expect(store.trustedPeer(KEY_A)).toBeUndefined();
    expect(store.trustedPeer(KEY_B)).toBeDefined();
    expect(store.listTrustedPeers().map((record) => record.label)).toEqual(["No expiry", "Valid"]);
  });

  test("touchTrustedPeerLastSeen updates last_seen_at", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer());
    expect(store.trustedPeer(KEY_A)?.lastSeenAt).toBeUndefined();

    const at = Date.now();
    store.touchTrustedPeerLastSeen(KEY_A, at);
    expect(store.trustedPeer(KEY_A)?.lastSeenAt).toBe(at);
  });

  test("tier check constraint rejects an invalid tier", () => {
    const store = createStore();
    expect(() =>
      store.upsertTrustedPeer(peer({ tier: "admin" as TrustedPeerRecord["tier"] })),
    ).toThrow();
    expect(store.trustedPeer(KEY_A)).toBeUndefined();
  });
});

describe("trusted peer TLS pins (mesh-trust-cone §11.2)", () => {
  const PIN_A = "a".repeat(64);
  const PIN_B = "b".repeat(64);

  test("migration 0008: trusted_peers carries a nullable tls_spki_fingerprint column", () => {
    createStore();
    const db = new Database(dbFileOf());
    const cols = db.query("PRAGMA table_info('trusted_peers')").all() as Array<{ name: string; notnull: number }>;
    const column = cols.find((candidate) => candidate.name === "tls_spki_fingerprint");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    db.close();
  });

  test("the guarded repair restores the column on a pre-0008 table, data intact", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer());
    const db = new Database(dbFileOf());
    db.exec("ALTER TABLE trusted_peers DROP COLUMN tls_spki_fingerprint");
    db.close();

    // Re-opening re-runs the migration pipeline: the imperative guarded ALTER
    // covers tables that predate the column (ledger-seeded databases).
    const reopened = new SQLiteControlPlaneStore(dbFileOf());
    expect(reopened.trustedPeer(KEY_A)).toBeDefined();
    expect(reopened.getTlsSpkiFingerprint(KEY_A)).toBeUndefined();
    reopened.setTlsSpkiFingerprint(KEY_A, PIN_A);
    expect(reopened.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_A);
  });

  test("upsert with a tls pin stores it; getTlsSpkiFingerprint reads it", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer({ tlsSpkiFingerprint: PIN_A }));
    expect(store.trustedPeer(KEY_A)?.tlsSpkiFingerprint).toBe(PIN_A);
    expect(store.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_A);
    expect(store.getTlsSpkiFingerprint(KEY_MISSING)).toBeUndefined();
  });

  test("a tls-absent re-enrollment NEVER clears or overwrites an existing pin", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer({ tlsSpkiFingerprint: PIN_A }));

    // Re-enrollment with a tls-absent card: full upsert, no tls field.
    store.upsertTrustedPeer(peer({ grantedAt: 1_700_000_500_000, label: "Air Renamed" }));
    expect(store.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_A);
    expect(store.trustedPeer(KEY_A)?.tlsSpkiFingerprint).toBe(PIN_A);
    expect(store.trustedPeer(KEY_A)?.label).toBe("Air Renamed");
  });

  test("a tls-present re-enrollment replaces the pin", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer({ tlsSpkiFingerprint: PIN_A }));
    store.upsertTrustedPeer(peer({ tlsSpkiFingerprint: PIN_B }));
    expect(store.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_B);
  });

  test("setTlsSpkiFingerprint writes only well-formed pins and never clears", () => {
    const store = createStore();
    store.upsertTrustedPeer(peer());

    expect(store.setTlsSpkiFingerprint(KEY_A, PIN_A)).toBe(true);
    expect(store.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_A);
    expect(store.setTlsSpkiFingerprint(KEY_MISSING, PIN_B)).toBe(false);

    for (const malformed of ["A".repeat(64), "abc", "g".repeat(64), ""]) {
      expect(() => store.setTlsSpkiFingerprint(KEY_A, malformed)).toThrow(/64 lowercase hex/);
    }
    expect(store.getTlsSpkiFingerprint(KEY_A)).toBe(PIN_A);
  });
});
