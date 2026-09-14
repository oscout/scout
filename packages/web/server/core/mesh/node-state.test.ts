import { describe, expect, test } from "bun:test";

import {
  backoffDelayMs,
  createMeshNodeStateStore,
  isTailnetAddress,
  meshMachineTargets,
  readMeshNodeState,
  type MeshMachineTarget,
  type MeshNodeStateView,
} from "./node-state.ts";
import type { MeshStatusReport } from "./service.ts";

/* ── Fixtures ── */

function node(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    meshId: "openscout",
    name,
    hostName: name,
    advertiseScope: "mesh",
    registeredAt: 1,
    capabilities: ["broker"],
    ...extra,
  };
}

function peer(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, addresses: [], online: true, hostName: name, ...extra };
}

function mesh(overrides: Partial<MeshStatusReport> = {}): MeshStatusReport {
  return {
    brokerUrl: "http://127.0.0.1:43110",
    health: "ok",
    localNode: node("arts-mini-openscout", "arts-mini"),
    meshId: "openscout",
    identity: {},
    nodes: {
      "arts-mini-openscout": node("arts-mini-openscout", "arts-mini"),
      "arc-server-openscout": node("arc-server-openscout", "arc-server", {
        brokerUrl: "http://arc-server:43110",
      }),
    },
    tailscale: {
      available: true,
      running: true,
      backendState: "Running",
      health: [],
      peers: [peer("p-arc", "arc-server"), peer("p-ipad", "ipad", { dnsName: "ipad-air.tail.ts.net" })],
      onlineCount: 2,
    },
    issues: [],
    warnings: [],
    ...overrides,
  } as unknown as MeshStatusReport;
}

function target(overrides: Partial<MeshMachineTarget> = {}): MeshMachineTarget {
  return {
    machineId: "arc-server-openscout",
    kind: "peer",
    label: "arc-server",
    brokerUrl: "http://arc-server:43110",
    expectedNodeId: "arc-server-openscout",
    node: {
      id: "arc-server-openscout",
      name: "arc-server",
      hostName: "arc-server",
      meshId: "openscout",
      brokerUrl: "http://arc-server:43110",
      capabilities: ["broker"],
      lastSeenAt: null,
    },
    tailnetOnline: true,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    kind: "mesh-node-state",
    version: 1,
    nodeId: "arc-server-openscout",
    meshId: "openscout",
    name: "arc-server",
    hostName: "arc-server",
    capabilities: ["broker"],
    observedAt: 5_000,
    workload: { total: 2, working: 1, available: 1, offline: 0, truncated: false },
    roster: [
      { id: "exedev.arc-server", title: "exedev", role: null, projectRoot: null, state: "working", statusLabel: "working", lastSeenAt: 4_900 },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ── Inventory ── */

describe("meshMachineTargets", () => {
  test("names every known node plus tailnet-only devices, and nothing else", () => {
    const targets = meshMachineTargets(mesh({
      tailscale: {
        available: true,
        running: true,
        backendState: "Running",
        health: [],
        peers: [peer("p-arc", "arc-server"), peer("p-ipad", "ipad", { dnsName: "ipad-air.tail.ts.net" })],
        onlineCount: 2,
      },
    } as Partial<MeshStatusReport>));

    expect(targets.map((row) => row.machineId)).toEqual([
      "arts-mini-openscout",
      "arc-server-openscout",
      "tailnet:p-ipad",
    ]);
    expect(targets[0]?.kind).toBe("local");
    expect(targets[1]?.kind).toBe("peer");
    expect(targets[2]?.kind).toBe("tailnet");
  });

  test("adopts a tailnet twin's presence for a known node", () => {
    const [, arc] = meshMachineTargets(mesh({
      tailscale: {
        available: true,
        running: true,
        backendState: "Running",
        health: [],
        peers: [peer("p-arc", "arc-server", { online: false })],
        onlineCount: 0,
      },
    } as Partial<MeshStatusReport>));

    expect(arc?.tailnetOnline).toBe(false);
  });

  test("leaves presence unknown when tailscale itself is not running", () => {
    const [, arc] = meshMachineTargets(mesh({
      tailscale: {
        available: true,
        running: false,
        backendState: "Stopped",
        health: [],
        peers: [peer("p-arc", "arc-server")],
        onlineCount: 0,
      },
    } as Partial<MeshStatusReport>));

    expect(arc?.tailnetOnline).toBe(false);
  });

  test("never dials a shared private LAN address for a tailnet-only device", () => {
    // Several exe VMs advertise 10.42.0.42; it reaches no specific machine and
    // identifies none, so it must never become a broker address.
    const targets = meshMachineTargets(mesh({
      nodes: {},
      localNode: null,
      tailscale: {
        available: true,
        running: true,
        backendState: "Running",
        health: [],
        peers: [peer("p-vm", "exe-vm", { addresses: ["10.42.0.42", "192.168.1.20"] })],
        onlineCount: 1,
      },
    } as Partial<MeshStatusReport>));

    expect(targets).toHaveLength(1);
    expect(targets[0]?.brokerUrl).toBeNull();
  });

  test("dials a tailnet device on its tailnet address only", () => {
    const targets = meshMachineTargets(mesh({
      nodes: {},
      localNode: null,
      tailscale: {
        available: true,
        running: true,
        backendState: "Running",
        health: [],
        peers: [peer("p-vm", "exe-vm", { addresses: ["10.42.0.42", "100.101.102.103"] })],
        onlineCount: 1,
      },
    } as Partial<MeshStatusReport>));

    // A device that never announced a broker has no announced scheme either;
    // mesh brokers serve https, so that is dialled first with http as a retry.
    expect(targets[0]?.brokerUrl).toBe("https://100.101.102.103:43110");
    expect(targets[0]?.fallbackBrokerUrl).toBe("http://100.101.102.103:43110");
    expect(targets[0]?.expectedNodeId).toBeNull();
  });

  test("recognizes tailnet addresses without trusting private ranges", () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.127.255.254")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("10.42.0.42")).toBe(false);
    expect(isTailnetAddress("192.168.1.20")).toBe(false);
  });
});

/* ── One check ── */

describe("readMeshNodeState", () => {
  test("reads compact state from a peer over the signed client", async () => {
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => jsonResponse(report()),
      now: () => 9_000,
    });

    expect(view.broker).toBe("answered");
    expect(view.network).toBe("reachable");
    expect(view.detail).toBe("full");
    expect(view.source).toBe("node-state");
    expect(view.observedAt).toBe(5_000);
    expect(view.checkedAt).toBe(9_000);
    expect(view.workload).toEqual({
      total: 2, working: 1, available: 1, offline: 0, truncated: false, unattributed: 0,
    });
    expect(view.roster.map((row) => row.id)).toEqual(["exedev.arc-server"]);
  });

  test("refuses a payload that claims a different node than the one dialled", async () => {
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => jsonResponse(report({ nodeId: "someone-else-openscout" })),
    });

    expect(view.broker).toBe("refused");
    expect(view.network).toBe("reachable");
    expect(view.error).toContain("someone-else-openscout");
    expect(view.roster).toHaveLength(0);
    expect(view.workload).toBeNull();
  });

  test("accepts a tailnet device's own node id, since none was announced", async () => {
    const view = await readMeshNodeState(
      target({ machineId: "tailnet:p-vm", kind: "tailnet", expectedNodeId: null, node: null }),
      null,
      { peerFetch: async () => jsonResponse(report({ nodeId: "discovered-openscout" })) },
    );

    expect(view.broker).toBe("answered");
    expect(view.node?.id).toBe("discovered-openscout");
  });

  test("reads an older peer as unsupported without falling back on a poll", async () => {
    const paths: string[] = [];
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async (_base, path) => {
        paths.push(path);
        return jsonResponse({ error: "not found" }, 404);
      },
    });

    expect(view.broker).toBe("unsupported");
    expect(view.network).toBe("reachable");
    expect(view.workload).toBeNull();
    expect(paths).toEqual(["/v1/mesh/node-state"]);
  });

  test("projects an older peer's snapshot on selection, with liveness left unknown", async () => {
    const view = await readMeshNodeState(target(), null, {
      deep: true,
      now: () => 7_000,
      peerFetch: async (_base, path) => {
        if (path === "/v1/mesh/node-state") return jsonResponse({}, 404);
        return jsonResponse({
          agents: {
            a: { id: "a", displayName: "Remix Lab", homeNodeId: "arc-server-openscout" },
            b: { id: "b", displayName: "Elsewhere", homeNodeId: "ocean-iron-openscout" },
            c: { id: "c", displayName: "Unplaced" },
          },
        });
      },
    });

    expect(view.broker).toBe("answered");
    expect(view.detail).toBe("roster");
    expect(view.source).toBe("snapshot");
    expect(view.observedAt).toBe(7_000);
    // Registered here, liveness unattested: counters stay null rather than 0.
    expect(view.workload).toEqual({
      total: 1, working: null, available: null, offline: null, truncated: false, unattributed: 2,
    });
    expect(view.roster.map((row) => row.id)).toEqual(["a"]);
    expect(view.roster[0]?.state).toBeNull();
  });

  test("keeps the last good reading, marked stale, when a check fails", async () => {
    const good = await readMeshNodeState(target(), null, {
      peerFetch: async () => jsonResponse(report()),
      now: () => 9_000,
    });
    const bad = await readMeshNodeState(target(), good, {
      peerFetch: async () => { throw new Error("connect ECONNREFUSED"); },
      now: () => 12_000,
    });

    expect(bad.broker).toBe("unreachable");
    expect(bad.stale).toBe(true);
    expect(bad.observedAt).toBe(5_000);
    expect(bad.roster.map((row) => row.id)).toEqual(["exedev.arc-server"]);
    expect(bad.checkedAt).toBe(12_000);
  });

  test("reads this machine from the registry when its broker predates the route", async () => {
    const local = target({
      machineId: "arts-mini-openscout",
      kind: "local",
      label: "arts-mini",
      brokerUrl: null,
      expectedNodeId: "arts-mini-openscout",
      node: null,
    });
    const view = await readMeshNodeState(local, null, {
      readLocal: async () => { throw new Error("/v1/mesh/node-state returned 404"); },
      readLocalSnapshot: async () => report({
        nodeId: "arts-mini-openscout",
        name: "arts-mini",
        hostName: "arts-mini",
        workload: { total: 3, working: 1, available: 1, offline: 1, truncated: false },
        sessions: { total: 14, truncated: false, items: [] },
      }) as never,
      now: () => 9_000,
    });

    expect(view.broker).toBe("answered");
    expect(view.detail).toBe("full");
    expect(view.workload?.working).toBe(1);
    expect(view.sessions?.total).toBe(14);
  });

  test("reports this machine as unread rather than idle when nothing can attest it", async () => {
    const local = target({
      machineId: "arts-mini-openscout",
      kind: "local",
      brokerUrl: null,
      expectedNodeId: "arts-mini-openscout",
      node: null,
    });
    const view = await readMeshNodeState(local, null, {
      readLocal: async () => { throw new Error("404"); },
      // A snapshot that cannot see sessions refuses to answer rather than
      // reporting every agent offline on a machine that is mid-turn.
      readLocalSnapshot: async () => null,
    });

    expect(view.broker).toBe("unreachable");
    expect(view.workload).toBeNull();
    expect(view.roster).toEqual([]);
  });

  test("reads a TLS pin failure as a live peer refusing us, not a dead host", async () => {
    const error = new Error("pin mismatch");
    error.name = "PeerTlsPinError";
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => { throw error; },
    });

    expect(view.broker).toBe("refused");
    expect(view.network).toBe("reachable");
  });

  test("refuses an oversized body instead of buffering it", async () => {
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => new Response(JSON.stringify(report()), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024) },
      }),
    });

    // A host that answers is not a host that is down, whatever it answered.
    expect(view.broker).toBe("unsupported");
    expect(view.network).toBe("reachable");
    expect(view.error).toContain("bound");
  });

  test("stops reading a huge body that never declared its length", async () => {
    let produced = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunk.byteLength;
        // Far past the cap: if the reader did not stop, this never ends.
        if (produced > 32 * 1024 * 1024) { controller.close(); return; }
        controller.enqueue(chunk);
      },
    });

    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    expect(view.broker).toBe("unsupported");
    expect(view.error).toContain("bound");
    // The cap is enforced while reading: we stopped near it, not at the end.
    expect(produced).toBeLessThan(2 * 1024 * 1024);
  });

  test("reads unreadable JSON as a broker we cannot use, not a dead machine", async () => {
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => new Response("{ not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    expect(view.broker).toBe("unsupported");
    expect(view.network).toBe("reachable");
    expect(view.workload).toBeNull();
  });

  test("re-caps a peer that answers with thousands of roster rows", async () => {
    const roster = Array.from({ length: 1_000 }, (_, index) => ({
      id: `agent-${index}`,
      title: `agent ${index}`,
      role: null,
      projectRoot: null,
      state: "available",
      statusLabel: "ready",
      lastSeenAt: 1,
    }));
    const view = await readMeshNodeState(target(), null, {
      peerFetch: async () => jsonResponse(report({
        roster,
        workload: { total: 1_000, working: 0, available: 1_000, offline: 0, truncated: false },
        sessions: { total: 900, truncated: false, items: roster.map((row) => ({ id: row.id, agentId: row.id, harness: null, transport: null, state: "live", sessionId: null, projectRoot: null })) },
      })),
    });

    expect(view.roster.length).toBe(24);
    expect(view.sessions?.items.length).toBe(16);
    expect(view.sessions?.truncated).toBe(true);
    // The peer's own totals are still reported honestly.
    expect(view.workload?.total).toBe(1_000);
  });

  test("will not project a legacy snapshot for a device with no node identity", async () => {
    let dialled: string[] = [];
    const view = await readMeshNodeState(
      target({
        machineId: "tailnet:p-vm",
        kind: "tailnet",
        brokerUrl: "https://100.64.1.2:43110",
        expectedNodeId: null,
        node: null,
      }),
      null,
      {
        deep: true,
        peerFetch: async (_base, path) => {
          dialled.push(path);
          return new Response("nope", { status: 403 });
        },
      },
    );

    expect(view.broker).toBe("unsupported");
    expect(view.roster).toEqual([]);
    // The whole-registry route is never asked: with no node id there is nothing
    // to scope it by, and an unscoped registry is other machines' agents.
    expect(dialled.some((path) => path.includes("snapshot"))).toBe(false);
    expect(view.error).toContain("node identity");
  });

  test("prefers a node's tailnet address over a LAN address several machines share", () => {
    const targets = meshMachineTargets(mesh({
      nodes: {
        "arts-mini-openscout": node("arts-mini-openscout", "arts-mini"),
        "ocean-iron-openscout": node("ocean-iron-openscout", "ocean-iron", {
          // Every exe VM publishes this one. Dialling it reaches whichever VM
          // answers, which is never a specific machine.
          brokerUrl: "https://10.42.0.42:43110",
        }),
      },
      tailscale: {
        available: true,
        running: true,
        backendState: "Running",
        health: [],
        peers: [peer("p-ocean", "ocean-iron", { addresses: ["10.42.0.42", "100.121.36.97"] })],
        onlineCount: 1,
      },
    } as Partial<MeshStatusReport>));

    const ocean = targets.find((t) => t.machineId === "ocean-iron-openscout");
    expect(ocean?.brokerUrl).toBe("https://100.121.36.97:43110");
  });

  test("leaves an announced hostname alone", () => {
    const targets = meshMachineTargets(mesh());
    const arc = targets.find((t) => t.machineId === "arc-server-openscout");
    expect(arc?.brokerUrl).toBe("http://arc-server:43110");
  });

  test("says so plainly when a machine publishes no address to reach", async () => {
    const view = await readMeshNodeState(
      target({ machineId: "tailnet:p-vm", kind: "tailnet", brokerUrl: null, expectedNodeId: null, node: null, tailnetOnline: true }),
      null,
      { peerFetch: async () => { throw new Error("should not dial"); } },
    );

    expect(view.broker).toBe("unknown");
    expect(view.workload).toBeNull();
    expect(view.error).toContain("no reachable address");
  });
});

/* ── Backoff ── */

describe("backoffDelayMs", () => {
  test("doubles per consecutive failure and stops at five minutes", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(10_000);
    expect(backoffDelayMs(3)).toBe(20_000);
    expect(backoffDelayMs(20)).toBe(300_000);
  });
});

/* ── Store ── */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function answered(machineId: string, now: number, overrides: Partial<MeshNodeStateView> = {}): MeshNodeStateView {
  return {
    machineId,
    kind: "peer",
    label: machineId,
    network: "reachable",
    broker: "answered",
    detail: "full",
    source: "node-state",
    checkedAt: now,
    observedAt: now,
    stale: false,
    checking: false,
    error: null,
    node: null,
    workload: { total: 1, working: 1, available: 0, offline: 0, truncated: false, unattributed: 0 },
    roster: [],
    failures: 0,
    nextAttemptAt: null,
    ...overrides,
  };
}

describe("createMeshNodeStateStore", () => {
  test("answers immediately with known inventory while checks are still running", async () => {
    const gate = deferred<void>();
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async (row) => {
        await gate.promise;
        return answered(row.machineId, 1_000);
      },
    });

    const listed = await store.list();
    // One slow peer must not hold the page hostage: the row is present and
    // marked checking, with no state invented for it.
    expect(listed.nodes.map((row) => row.machineId)).toEqual([
      "arts-mini-openscout", "arc-server-openscout", "tailnet:p-ipad",
    ]);
    expect(listed.nodes.every((row) => row.checking)).toBe(true);
    expect(listed.nodes.every((row) => row.workload === null)).toBe(true);

    gate.resolve();
    await store.idle();
    const settled = await store.list();
    expect(settled.nodes.every((row) => row.broker === "answered")).toBe(true);
  });

  test("coalesces concurrent viewers onto one probe per machine", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async (row) => {
        calls += 1;
        await gate.promise;
        return answered(row.machineId, 1_000);
      },
    });

    await Promise.all([store.list(), store.list(), store.list()]);
    gate.resolve();
    await store.idle();

    expect(calls).toBe(3); // three machines, once each — not nine
  });

  test("holds the concurrency ceiling across list and selection callers alike", async () => {
    let active = 0;
    let peak = 0;
    const store = createMeshNodeStateStore({
      maxConcurrency: 2,
      loadMesh: async () => mesh(),
      fetchState: async (row) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return answered(row.machineId, 1_000);
      },
    });

    // Three machines swept plus a selection: more work than slots, so the
    // ceiling has to hold across both callers rather than per call.
    await Promise.all([store.list(), store.read("tailnet:p-ipad", { force: true })]);
    await store.idle();

    expect(peak).toBe(2);
  });

  test("serves a fresh reading without touching the network again", async () => {
    let calls = 0;
    let clock = 1_000;
    const store = createMeshNodeStateStore({
      now: () => clock,
      loadMesh: async () => mesh(),
      fetchState: async (row) => {
        calls += 1;
        return answered(row.machineId, clock);
      },
    });

    await store.read("arc-server-openscout");
    await store.idle();
    clock += 1_000;
    await store.read("arc-server-openscout");

    expect(calls).toBe(1);
  });

  test("manual refresh re-checks even a fresh machine", async () => {
    let calls = 0;
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async (row) => { calls += 1; return answered(row.machineId, 1_000); },
    });

    await store.read("arc-server-openscout");
    await store.idle();
    await store.read("arc-server-openscout", { force: true });

    expect(calls).toBe(2);
  });

  test("backs off a failing machine instead of hammering it every poll", async () => {
    let calls = 0;
    let clock = 1_000;
    const store = createMeshNodeStateStore({
      now: () => clock,
      loadMesh: async () => mesh(),
      fetchState: async (row) => {
        calls += 1;
        return { ...answered(row.machineId, clock), broker: "unreachable", source: null, workload: null };
      },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await store.read("arc-server-openscout", { force: true });
      await store.idle();
      clock += 1;
    }
    expect(calls).toBe(4);

    clock += 30_000; // past the freshness window, still inside the 40s backoff
    const held = await store.read("arc-server-openscout");
    await store.idle();
    expect(calls).toBe(4);
    expect(held?.failures).toBe(4);
    expect(held?.nextAttemptAt).toBe(41_003);

    clock += 20_000; // past the backoff
    await store.read("arc-server-openscout");
    await store.idle();
    expect(calls).toBe(5);
  });

  test("a selection retries deeper rather than inheriting a poll's unsupported answer", async () => {
    const seen: boolean[] = [];
    const gate = deferred<void>();
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async (row, _previous, options) => {
        seen.push(Boolean(options?.deep));
        await gate.promise;
        return options?.deep
          ? { ...answered(row.machineId, 1_000), detail: "roster", source: "snapshot" }
          : { ...answered(row.machineId, 1_000), broker: "unsupported", detail: "none", source: null, workload: null };
      },
    });

    const listing = store.list();
    const selection = store.read("arc-server-openscout", { deep: true });
    gate.resolve();
    await listing;
    const view = await selection;
    await store.idle();

    expect(seen).toContain(true);
    expect(view?.broker).toBe("answered");
    expect(view?.detail).toBe("roster");
  });

  test("two viewers selecting at once share one deep upgrade", async () => {
    let shallow = 0;
    let deep = 0;
    const gate = deferred<void>();
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async (row, _previous, options) => {
        if (options?.deep) {
          deep += 1;
          return { ...answered(row.machineId, 1_000), detail: "roster", source: "snapshot" };
        }
        shallow += 1;
        await gate.promise;
        return { ...answered(row.machineId, 1_000), broker: "unsupported", detail: "none", source: null, workload: null };
      },
    });

    const listing = store.list();
    const first = store.read("arc-server-openscout", { deep: true });
    const second = store.read("arc-server-openscout", { deep: true });
    gate.resolve();
    await listing;
    const [a, b] = await Promise.all([first, second]);
    await store.idle();

    expect(shallow).toBe(3);
    // Both waiters resume together once the sweep's shallow check lands; the
    // second must join the upgrade, not open a second probe at the peer.
    expect(deep).toBe(1);
    expect(a?.detail).toBe("roster");
    expect(b?.detail).toBe("roster");
  });

  test("keeps deep detail through later shallow polls", async () => {
    let clock = 1_000;
    const store = createMeshNodeStateStore({
      now: () => clock,
      loadMesh: async () => mesh(),
      fetchState: async (row, previous, options) => {
        if (options?.deep) {
          return { ...answered(row.machineId, clock), detail: "roster", source: "snapshot" };
        }
        // A shallow poll on an older peer learns nothing new; it must not erase
        // what the selection already established.
        return {
          ...answered(row.machineId, clock),
          broker: "unsupported",
          detail: previous?.detail ?? "none",
          source: previous?.source ?? null,
          roster: previous?.roster ?? [],
          workload: previous?.workload ?? null,
          stale: Boolean(previous?.source),
        };
      },
    });

    await store.read("arc-server-openscout", { deep: true });
    await store.idle();
    clock += 60_000;
    const polled = await store.read("arc-server-openscout", { force: true });

    expect(polled?.detail).toBe("roster");
    expect(polled?.stale).toBe(true);
  });

  test("rejects a machine id the mesh does not publish", async () => {
    const store = createMeshNodeStateStore({
      loadMesh: async () => mesh(),
      fetchState: async () => { throw new Error("must not dial"); },
    });

    expect(await store.read("http://attacker.example/x")).toBeNull();
    expect(await store.read("some-unknown-openscout")).toBeNull();
  });

  test("forgets machines the mesh no longer publishes", async () => {
    let nodes = mesh();
    const store = createMeshNodeStateStore({
      loadMesh: async () => nodes,
      fetchState: async (row) => answered(row.machineId, 1_000),
    });

    await store.list();
    await store.idle();
    nodes = mesh({ nodes: { "arts-mini-openscout": node("arts-mini-openscout", "arts-mini") } } as Partial<MeshStatusReport>);
    const listed = await store.list({ refresh: false });

    expect(listed.nodes.map((row) => row.machineId)).toEqual([
      "arts-mini-openscout", "tailnet:p-arc", "tailnet:p-ipad",
    ]);
  });
});
