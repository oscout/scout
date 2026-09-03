import { describe, expect, test } from "bun:test";

import { BrokerRouteAliasStore } from "./broker-route-alias-store.js";
import { LazyControlPlaneStore } from "./lazy-control-plane-store.js";
import type {
  ControlPlaneSqliteDatabase,
  ControlPlaneSqliteStatement,
} from "./sqlite-adapter.js";
import type { SQLiteControlPlaneStore } from "./sqlite-store.js";

describe("LazyControlPlaneStore", () => {
  test("wires projection, aliases, and trust without opening SQLite", () => {
    let openings = 0;
    const store = fakeStore();
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return store;
    });

    const routeAliases = new BrokerRouteAliasStore(shared.routeAliasDatabase);
    const projectionFactory = shared.createProjectionStore;
    const trustedPeers = shared;

    expect(routeAliases).toBeDefined();
    expect(projectionFactory).toBeDefined();
    expect(trustedPeers).toBeDefined();
    expect(openings).toBe(0);

    expect(routeAliases.list({
      ownerRealmId: "mesh-1",
      projectKey: "project-1",
      nodeId: "node-1",
    })).toEqual([]);
    expect(openings).toBe(1);
    expect(projectionFactory("ignored.sqlite")).toBe(store);
    expect(openings).toBe(1);
    expect(shared.listTrustedPeers()).toEqual([]);
    expect(openings).toBe(1);
  });

  test("reopens after projection ownership closes the current store", () => {
    let openings = 0;
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return fakeStore();
    });

    const first = shared.get();
    first.close();
    const second = shared.get();

    expect(first.isClosed).toBe(true);
    expect(second).not.toBe(first);
    expect(openings).toBe(2);
    shared.close();
  });

  test("closing an unused provider does not construct its store", () => {
    let openings = 0;
    const shared = new LazyControlPlaneStore(() => {
      openings += 1;
      return fakeStore();
    });

    shared.close();
    shared.close();

    expect(openings).toBe(0);
    expect(() => shared.get()).toThrow("control-plane SQLite store is closed");
  });
});

function fakeStore(): SQLiteControlPlaneStore {
  let closed = false;
  const statement: ControlPlaneSqliteStatement = {
    all: () => [],
    get: () => null,
    run: () => undefined,
  };
  const database: ControlPlaneSqliteDatabase = {
    exec: () => undefined,
    query: () => statement,
  };
  return {
    get isClosed() {
      return closed;
    },
    writerDb: database,
    trustedPeer: () => undefined,
    listTrustedPeers: () => [],
    upsertTrustedPeer: () => undefined,
    revokeTrustedPeer: () => false,
    claimPeerNonce: () => true,
    compactAndPruneMeshNodes: () => ({
      rehomedNodeCount: 0,
      prunedNodeCount: 0,
      rehomedMappings: [],
    }),
    close: () => {
      closed = true;
    },
  } as unknown as SQLiteControlPlaneStore;
}
