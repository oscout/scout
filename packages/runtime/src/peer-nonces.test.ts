import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const dbRoots = new Set<string>();

afterEach(() => {
  for (const root of dbRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  dbRoots.clear();
});

function createStore(): SQLiteControlPlaneStore {
  const root = mkdtempSync(join(tmpdir(), "openscout-peer-nonces-"));
  dbRoots.add(root);
  return new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
}

function createStoreWithPath(): { store: SQLiteControlPlaneStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "openscout-peer-nonces-"));
  dbRoots.add(root);
  const dbPath = join(root, "control-plane.sqlite");
  return {
    store: new SQLiteControlPlaneStore(dbPath),
    dbPath,
  };
}

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const MAX_AGE_MS = 60_000;

describe("peer nonce claims", () => {
  test("first claim succeeds, duplicate is rejected", () => {
    const store = createStore();
    const now = Date.now();
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now, MAX_AGE_MS)).toBe(true);
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now + 1, MAX_AGE_MS)).toBe(false);
    expect(store.claimPeerNonce(KEY_A, "nonce-2", now + 1, MAX_AGE_MS)).toBe(true);
  });

  test("claims survive a store re-open", () => {
    const { store, dbPath } = createStoreWithPath();
    const now = Date.now();
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now, MAX_AGE_MS)).toBe(true);
    store.close();

    const reopened = new SQLiteControlPlaneStore(dbPath);
    expect(reopened.claimPeerNonce(KEY_A, "nonce-1", now + 1, MAX_AGE_MS)).toBe(false);
    reopened.close();
  });

  test("sweep removes aged-out rows so an old nonce can be claimed again", () => {
    const store = createStore();
    const now = Date.now();
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now, MAX_AGE_MS)).toBe(true);
    // Still inside the window: rejected.
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now + MAX_AGE_MS - 1, MAX_AGE_MS)).toBe(false);
    // Past the window: the claim sweeps the stale row, then re-claims.
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now + MAX_AGE_MS + 1, MAX_AGE_MS)).toBe(true);
    // The re-claimed row is fresh again.
    expect(store.claimPeerNonce(KEY_A, "nonce-1", now + MAX_AGE_MS + 2, MAX_AGE_MS)).toBe(false);
  });

  test("different peers claim the same nonce value independently", () => {
    const store = createStore();
    const now = Date.now();
    expect(store.claimPeerNonce(KEY_A, "shared-nonce", now, MAX_AGE_MS)).toBe(true);
    expect(store.claimPeerNonce(KEY_B, "shared-nonce", now, MAX_AGE_MS)).toBe(true);
    expect(store.claimPeerNonce(KEY_A, "shared-nonce", now + 1, MAX_AGE_MS)).toBe(false);
    expect(store.claimPeerNonce(KEY_B, "shared-nonce", now + 1, MAX_AGE_MS)).toBe(false);
  });
});
