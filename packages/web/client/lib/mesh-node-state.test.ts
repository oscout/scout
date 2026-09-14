import { describe, expect, test } from "bun:test";

import {
  createMeshNodeStateStore,
  isEvidencedIdle,
  isOlderReading,
  mergeNodeStateView,
  nodeStateRank,
  summarizeNodeReach,
  type MeshNodeStateList,
  type MeshNodeStateTransport,
  type MeshNodeStateView,
} from "./mesh-node-state.ts";

function view(overrides: Partial<MeshNodeStateView> = {}): MeshNodeStateView {
  return {
    machineId: "arc-server-openscout",
    kind: "peer",
    label: "arc-server",
    network: "reachable",
    broker: "answered",
    detail: "full",
    source: "node-state",
    checkedAt: 1_000,
    observedAt: 1_000,
    stale: false,
    checking: false,
    error: null,
    node: {
      id: "arc-server-openscout",
      name: "arc-server",
      hostName: "arc-server",
      meshId: "openscout",
      brokerUrl: "http://arc-server:43110",
      capabilities: ["broker"],
      lastSeenAt: null,
    },
    workload: { total: 2, working: 1, available: 1, offline: 0, truncated: false, unattributed: 0 },
    roster: [
      { id: "remix-lab.main.ocean-iron", title: "Remix Lab", role: null, projectRoot: null, state: "working", statusLabel: "working", lastSeenAt: 900 },
    ],
    sessions: { total: 1, truncated: false, items: [
      { id: "ep-1", agentId: "remix-lab.main.ocean-iron", harness: "codex", transport: "tmux", state: "active", sessionId: null, projectRoot: null },
    ] },
    work: { total: 1, running: 1, truncated: false, items: [
      { id: "flt-1", targetAgentId: "remix-lab.main.ocean-iron", state: "running", summary: null, startedAt: 900, completedAt: null },
    ] },
    failures: 0,
    nextAttemptAt: null,
    ...overrides,
  };
}

/** What a cheap sweep knows about a peer whose detail came from a selection. */
function sweepView(overrides: Partial<MeshNodeStateView> = {}): MeshNodeStateView {
  return view({
    detail: "none",
    source: null,
    workload: null,
    roster: [],
    sessions: null,
    work: null,
    checkedAt: 2_000,
    observedAt: null,
    ...overrides,
  });
}

describe("mergeNodeStateView", () => {
  test("ranks a full reading above a roster above a bare answer", () => {
    expect(nodeStateRank(view())).toBe(3);
    expect(nodeStateRank(view({ detail: "roster", source: "snapshot" }))).toBe(2);
    expect(nodeStateRank(view({ detail: "none", source: "node-state" }))).toBe(1);
    expect(nodeStateRank(view({ source: null }))).toBe(0);
  });

  test("takes the first reading as-is", () => {
    expect(mergeNodeStateView(null, view())).toEqual(view());
  });

  test("a fresh reading of the same richness replaces the old one", () => {
    const next = view({ checkedAt: 3_000, observedAt: 3_000, roster: [] });
    expect(mergeNodeStateView(view(), next)).toEqual(next);
  });

  test("a sweep does not take the selected machine's sections away", () => {
    const merged = mergeNodeStateView(view(), sweepView());
    // "Not reported by this sweep" must not overwrite "reported last time".
    expect(merged.sessions?.items).toHaveLength(1);
    expect(merged.work?.items).toHaveLength(1);
  });

  test("a sweep does not take the selected machine's detail away", () => {
    // The reported symptom: a remote entry appears, then a cheaper shared
    // response paints over it and the machine reads as having nothing on it.
    const merged = mergeNodeStateView(view(), sweepView());

    expect(merged.roster.map((row) => row.id)).toEqual(["remix-lab.main.ocean-iron"]);
    expect(merged.workload?.total).toBe(2);
    expect(merged.detail).toBe("full");
    expect(merged.stale).toBe(true);
    // …while still adopting what the sweep genuinely learned.
    expect(merged.checkedAt).toBe(2_000);
  });

  test("a failed check keeps the detail and reports the new verdict", () => {
    const merged = mergeNodeStateView(
      view(),
      sweepView({ broker: "unreachable", network: "unknown", error: "connect ECONNREFUSED", failures: 1 }),
    );

    expect(merged.broker).toBe("unreachable");
    expect(merged.error).toBe("connect ECONNREFUSED");
    expect(merged.stale).toBe(true);
    expect(merged.roster).toHaveLength(1);
  });

  test("drops a response describing an older moment than what is shown", () => {
    const shown = view({ checkedAt: 5_000 });
    expect(isOlderReading(shown, view({ checkedAt: 4_000 }))).toBe(true);
    expect(mergeNodeStateView(shown, view({ checkedAt: 4_000, roster: [] }))).toEqual(shown);
  });
});

/* ── Store ── */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function list(nodes: MeshNodeStateView[], updatedAt = 2_000): MeshNodeStateList {
  return { updatedAt, nodes };
}

function transport(overrides: Partial<MeshNodeStateTransport> = {}): MeshNodeStateTransport {
  return {
    list: async () => list([sweepView()]),
    read: async () => view(),
    refresh: async () => view(),
    ...overrides,
  };
}

describe("createMeshNodeStateStore", () => {
  test("shows known machines from the first sweep", async () => {
    const store = createMeshNodeStateStore(transport());
    await store.sweep();

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.view?.label).toBe("arc-server");
    expect(entry?.view?.workload).toBeNull();
    expect(store.snapshot().updatedAt).toBe(2_000);
  });

  test("keeps a selection's detail through repeated sweeps", async () => {
    // The server stamps every reading as it completes, so both streams move the
    // clock forward; the sweeps below are genuinely newer than the selection.
    let clock = 1_000;
    const store = createMeshNodeStateStore(transport({
      list: async () => { clock += 1_000; return list([sweepView({ checkedAt: clock })]); },
      read: async () => { clock += 1_000; return view({ checkedAt: clock, observedAt: clock }); },
    }));

    await store.sweep();
    await store.load("arc-server-openscout", { deep: true });
    await store.sweep();
    await store.sweep();
    await store.sweep();

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.view?.roster.map((row) => row.id)).toEqual(["remix-lab.main.ocean-iron"]);
    expect(entry?.view?.stale).toBe(true);
    expect(entry?.loading).toBe(false);
  });

  test("a sweep issued earlier never overwrites a selection that landed first", async () => {
    const slowList = deferred<MeshNodeStateList>();
    const store = createMeshNodeStateStore(transport({
      list: () => slowList.promise,
      read: async () => view({ checkedAt: 9_000, observedAt: 9_000 }),
    }));

    const sweeping = store.sweep();            // issued first
    await store.load("arc-server-openscout");  // issued second, lands first
    slowList.resolve(list([sweepView({ checkedAt: 9_500 })]));
    await sweeping;

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.view?.roster).toHaveLength(1);
    expect(entry?.view?.detail).toBe("full");
  });

  test("a superseded selection response is dropped", async () => {
    const first = deferred<MeshNodeStateView>();
    const responses = [first.promise, Promise.resolve(view({ checkedAt: 9_000, roster: [] }))];
    let call = 0;
    const store = createMeshNodeStateStore(transport({
      read: () => responses[call++]!,
    }));

    const stale = store.load("arc-server-openscout");
    await store.load("arc-server-openscout");
    first.resolve(view({ checkedAt: 1_000 }));
    await stale;

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.view?.checkedAt).toBe(9_000);
    expect(entry?.loading).toBe(false);
  });

  test("a sweep issued mid-selection does not discard the richer answer", async () => {
    // The sweep is the newer *request* and the older *knowledge*; ordering both
    // streams on one ticket line used to throw the selection's result away.
    const slowRead = deferred<MeshNodeStateView>();
    const store = createMeshNodeStateStore(transport({
      list: async () => list([sweepView()]),
      read: () => slowRead.promise,
    }));

    await store.sweep();
    const loading = store.load("arc-server-openscout", { deep: true });
    await store.sweep();
    slowRead.resolve(view({ checkedAt: 3_000, observedAt: 3_000 }));
    await loading;

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.view?.detail).toBe("full");
    expect(entry?.view?.roster).toHaveLength(1);
    expect(entry?.loading).toBe(false);
  });

  test("a machine selected before any sweep reports its own failure", async () => {
    const store = createMeshNodeStateStore(transport({
      list: async () => list([]),
      read: async () => { throw new Error("offline"); },
      refresh: async () => { throw new Error("offline"); },
    }));

    await store.load("arc-server-openscout");

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry).toBeTruthy();
    expect(entry?.view).toBeNull();
    expect(entry?.loading).toBe(false);
    expect(entry?.error).toBe("offline");
  });

  test("an out-of-order sweep does not roll the inventory back", async () => {
    const slowList = deferred<MeshNodeStateList>();
    let call = 0;
    const store = createMeshNodeStateStore(transport({
      list: () => (call++ === 0
        ? slowList.promise
        : Promise.resolve(list([view(), sweepView({ machineId: "tailnet:p-ipad", label: "ipad", kind: "tailnet" })]))),
    }));

    const stale = store.sweep();
    await store.sweep();
    slowList.resolve(list([view()]));
    await stale;

    expect(Object.keys(store.snapshot().entries).sort())
      .toEqual(["arc-server-openscout", "tailnet:p-ipad"]);
  });

  test("a sweep that predates a selection does not prune the selected machine", async () => {
    const slowList = deferred<MeshNodeStateList>();
    const store = createMeshNodeStateStore(transport({
      list: () => slowList.promise,
      read: async () => view({ machineId: "late-node-openscout" }),
    }));

    const sweeping = store.sweep();               // inventory taken before…
    await store.load("late-node-openscout");      // …this machine was selected
    slowList.resolve(list([]));
    await sweeping;

    expect(store.snapshot().entries["late-node-openscout"]?.view?.roster).toHaveLength(1);
  });

  test("a failed selection annotates the machine instead of blanking it", async () => {
    const store = createMeshNodeStateStore(transport({
      list: async () => list([view()]),
      read: async () => { throw new Error("network down"); },
    }));

    await store.sweep();
    await store.load("arc-server-openscout");

    const entry = store.snapshot().entries["arc-server-openscout"];
    expect(entry?.error).toBe("network down");
    expect(entry?.loading).toBe(false);
    expect(entry?.view?.roster).toHaveLength(1);
  });

  test("a failed sweep leaves the machines already on screen alone", async () => {
    let fail = false;
    const store = createMeshNodeStateStore(transport({
      list: async () => {
        if (fail) throw new Error("web server unreachable");
        return list([view()]);
      },
    }));

    await store.sweep();
    fail = true;
    await store.sweep();

    expect(store.snapshot().error).toBe("web server unreachable");
    expect(store.snapshot().entries["arc-server-openscout"]?.view?.roster).toHaveLength(1);
  });

  test("forgets a machine the mesh stopped publishing", async () => {
    let nodes = [view(), sweepView({ machineId: "tailnet:p-ipad", label: "ipad", kind: "tailnet" })];
    const store = createMeshNodeStateStore(transport({ list: async () => list(nodes) }));

    await store.sweep();
    expect(Object.keys(store.snapshot().entries)).toHaveLength(2);

    nodes = [view()];
    await store.sweep();
    expect(Object.keys(store.snapshot().entries)).toEqual(["arc-server-openscout"]);
  });

  test("a manual refresh goes through the refresh route", async () => {
    let refreshed = 0;
    const store = createMeshNodeStateStore(transport({
      list: async () => list([sweepView()]),
      refresh: async () => { refreshed += 1; return view({ checkedAt: 7_000 }); },
    }));

    await store.sweep();
    await store.load("arc-server-openscout", { force: true });

    expect(refreshed).toBe(1);
    expect(store.snapshot().entries["arc-server-openscout"]?.view?.checkedAt).toBe(7_000);
  });
});

/* ── Copy ── */

describe("summarizeNodeReach", () => {
  test("never calls an unchecked machine idle", () => {
    expect(summarizeNodeReach(null).label).toBe("Not checked yet");
    expect(summarizeNodeReach(sweepView({ broker: "unknown", network: "unknown" })).label)
      .toBe("Not checked yet");
    expect(summarizeNodeReach(sweepView({ broker: "unknown", network: "unreachable" })).label)
      .toBe("Offline");
  });

  test("separates a live peer refusing us from one that never answered", () => {
    expect(summarizeNodeReach(view({ broker: "refused", error: "pin mismatch" })).tone).toBe("bad");
    expect(summarizeNodeReach(view({ broker: "refused", error: "pin mismatch" })).detail).toBe("pin mismatch");
    expect(summarizeNodeReach(view({ broker: "unreachable" })).label).toBe("No answer");
  });

  test("says an older broker cannot report, rather than reporting nothing", () => {
    const summary = summarizeNodeReach(view({ broker: "unsupported", detail: "none", source: null }));
    expect(summary.label).toBe("Older broker");
    expect(summary.detail).toContain("does not report node state");
  });

  test("marks a kept reading as last known", () => {
    expect(summarizeNodeReach(view({ stale: true })).label).toBe("Last known");
    expect(summarizeNodeReach(view()).label).toBe("Responding");
  });
});

describe("isEvidencedIdle", () => {
  test("only an answered, current, empty roster counts as idle", () => {
    const empty = { total: 0, working: 0, available: 0, offline: 0, truncated: false, unattributed: 0 };
    expect(isEvidencedIdle(view({ workload: empty, roster: [] }))).toBe(true);
    expect(isEvidencedIdle(view({ workload: empty, roster: [], stale: true }))).toBe(false);
    expect(isEvidencedIdle(view({ workload: null, roster: [] }))).toBe(false);
    expect(isEvidencedIdle(view({ broker: "unreachable", workload: empty }))).toBe(false);
    expect(isEvidencedIdle(null)).toBe(false);
  });

  test("will not call a machine idle from an incomplete count", () => {
    // The legacy path can stop early — byte ceiling, a record too large to
    // parse — and a count that stopped early is a floor, not a census.
    expect(isEvidencedIdle(view({
      roster: [],
      workload: { total: 0, working: 0, available: 0, offline: 0, truncated: true, unattributed: 0 },
    }))).toBe(false);
  });

  test("will not call a machine idle from a source that cannot attest liveness", () => {
    expect(isEvidencedIdle(view({
      source: "snapshot",
      detail: "roster",
      roster: [],
      workload: { total: 0, working: null, available: null, offline: null, truncated: false, unattributed: 0 },
    }))).toBe(false);
  });
});
