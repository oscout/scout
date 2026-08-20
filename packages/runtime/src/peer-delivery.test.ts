import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  NodeDefinition,
} from "@openscout/protocol";

import {
  createPeerDeliveryWorker,
  type PeerDeliveryDeps,
} from "./peer-delivery.js";
import type { MeshForwardTarget } from "./mesh-forwarding.js";
import {
  PeerRejectedError,
  PeerUnreachableError,
} from "./mesh-forwarding.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/* ── Fixtures ── */

function makeNode(id: string, brokerUrl?: string): NodeDefinition {
  return {
    id,
    meshId: "test-mesh",
    name: id,
    advertiseScope: "mesh",
    brokerUrl,
    capabilities: ["broker"],
    registeredAt: 0,
    lastSeenAt: 0,
  };
}

function makeAgent(id: string, authorityNodeId: string): AgentDefinition {
  return {
    id,
    kind: "agent",
    displayName: id,
    handle: id,
    homeNodeId: authorityNodeId,
    authorityNodeId,
    advertiseScope: "mesh",
    state: "idle",
    workspace: "main",
    registeredAt: 0,
    updatedAt: 0,
  };
}

function makeInvocation(id: string, targetAgentId: string): InvocationRequest {
  return {
    id,
    requesterId: "actor-arach",
    targetAgentId,
    action: "invoke",
    task: "hello",
    createdAt: 0,
  };
}

function emptySnapshot(): RuntimeRegistrySnapshot {
  return {
    nodes: {},
    actors: {},
    agents: {},
    endpoints: {},
    conversations: {},
    bindings: {},
    messages: {},
    flights: {},
    collaborationRecords: {},
  };
}

/* ── Test harness ── */

interface Harness {
  deps: PeerDeliveryDeps;
  deliveries: Map<string, DeliveryIntent>;
  attempts: Map<string, Array<{ attempt: number; status: string; metadata?: Record<string, unknown> }>>;
  flights: FlightRecord[];
  failedInvocations: Array<{ invocation: InvocationRequest; detail: string }>;
  setNow: (ms: number) => void;
  setForward: (
    impl: (target: MeshForwardTarget) => Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }>,
  ) => void;
  setNode: (node: NodeDefinition | undefined) => void;
  setInvocation: (invocation: InvocationRequest | undefined) => void;
}

function makeHarness(opts: {
  invocation?: InvocationRequest;
  agent?: AgentDefinition;
  peer?: NodeDefinition;
} = {}): Harness {
  const deliveries = new Map<string, DeliveryIntent>();
  const attempts = new Map<
    string,
    Array<{ attempt: number; status: string; metadata?: Record<string, unknown> }>
  >();
  const flights: FlightRecord[] = [];
  const failedInvocations: Array<{ invocation: InvocationRequest; detail: string }> = [];

  let currentTime = 0;
  let invocation = opts.invocation;
  let peer = opts.peer;
  let forwardImpl:
    | ((target: MeshForwardTarget) => Promise<{ ok: true; flight: FlightRecord; duplicate?: boolean }>)
    | undefined;

  const localNode = makeNode("origin", "http://127.0.0.1:65501");

  const deps: PeerDeliveryDeps = {
    journal: {
      listDeliveries: () => [...deliveries.values()],
      listDeliveryAttempts: (deliveryId) =>
        (attempts.get(deliveryId) ?? []).map((a, idx) => ({
          id: `att-${deliveryId}-${idx}`,
          deliveryId,
          attempt: a.attempt,
          status: a.status as "sent" | "acknowledged" | "failed",
          createdAt: 0,
          metadata: a.metadata,
        })),
    },
    snapshot: emptySnapshot,
    localNode: () => localNode,
    localNodeId: localNode.id,
    nodeFor: (id) => (peer && peer.id === id ? peer : undefined),
    agentFor: () => opts.agent,
    invocationFor: (id) => (invocation && invocation.id === id ? invocation : undefined),
    recordDelivery: async (delivery) => {
      deliveries.set(delivery.id, delivery);
    },
    updateDeliveryStatus: async ({ deliveryId, status, metadata, leaseOwner, leaseExpiresAt }) => {
      const current = deliveries.get(deliveryId);
      if (!current) return;
      deliveries.set(deliveryId, {
        ...current,
        status,
        metadata: { ...(current.metadata ?? {}), ...(metadata ?? {}) },
        leaseOwner: leaseOwner ?? undefined,
        leaseExpiresAt: leaseExpiresAt ?? undefined,
      });
    },
    recordDeliveryAttempt: async (attempt) => {
      const list = attempts.get(attempt.deliveryId) ?? [];
      list.push({ attempt: attempt.attempt, status: attempt.status, metadata: attempt.metadata });
      attempts.set(attempt.deliveryId, list);
    },
    recordFlight: async (flight) => {
      flights.push(flight);
    },
    failInvocation: async (inv, detail) => {
      failedInvocations.push({ invocation: inv, detail });
    },
    forward: async (brokerUrl) => {
      if (!forwardImpl) throw new Error("forward impl not configured");
      return forwardImpl(brokerUrl);
    },
    now: () => currentTime,
  };

  return {
    deps,
    deliveries,
    attempts,
    flights,
    failedInvocations,
    setNow: (ms) => { currentTime = ms; },
    setForward: (impl) => { forwardImpl = impl; },
    setNode: (node) => { peer = node; },
    setInvocation: (inv) => { invocation = inv; },
  };
}

function targetErrorUrl(target: MeshForwardTarget): string {
  return typeof target === "string"
    ? target
    : target.brokerUrl ?? `mesh:${target.id}`;
}

/* ── Tests ── */

describe("peer-delivery outbox worker", () => {
  test("on success, marks delivery peer_acked and records the returned flight", async () => {
    const invocation = makeInvocation("inv-1", "scout.main.mini");
    const agent = makeAgent("scout.main.mini", "mini-node");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, agent, peer });

    const flight: FlightRecord = {
      id: "flt-peer-1",
      invocationId: "inv-1",
      requesterId: "actor-arach",
      targetAgentId: "scout.main.mini",
      state: "waking",
      startedAt: 100,
    };
    harness.setForward(async () => ({ ok: true, flight }));

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("peer_acked");
    expect(stored?.metadata?.peerFlightId).toBe("flt-peer-1");
    expect(harness.flights).toHaveLength(1);
    expect(harness.flights[0]?.id).toBe("flt-peer-1");

    const attempts = harness.attempts.get(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0]?.status).toBe("acknowledged");
    expect(harness.failedInvocations).toHaveLength(0);
  });

  test("on PeerUnreachableError, defers with backoff and stays retry-able", async () => {
    const invocation = makeInvocation("inv-2", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerUnreachableError("ECONNREFUSED", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    harness.setNow(1_000);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
    expect(typeof stored?.metadata?.nextAttemptAt).toBe("number");
    expect((stored?.metadata?.nextAttemptAt as number) > 1_000).toBe(true);
    expect(harness.failedInvocations).toHaveLength(0); // not terminal
  });

  test("on PeerRejectedError 4xx, fails terminally without retry", async () => {
    const invocation = makeInvocation("inv-3", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerRejectedError("bad request", targetErrorUrl(target), 400, "Bad Request", "{\"error\":\"unknown_node\"}");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.failureReason).toBe("peer_rejected");
    expect(harness.failedInvocations).toHaveLength(1);
    expect(harness.failedInvocations[0]?.detail).toContain("rejected");
  });

  test("on PeerRejectedError 5xx, defers (treated like unreachable)", async () => {
    const invocation = makeInvocation("inv-4", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerRejectedError("internal error", targetErrorUrl(target), 503, "Service Unavailable");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
    expect(harness.failedInvocations).toHaveLength(0);
  });

  test("after the retry window expires, marks failed and fails the invocation", async () => {
    const invocation = makeInvocation("inv-5", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async (target) => {
      throw new PeerUnreachableError("still down", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, {
      tickIntervalMs: 999_999,
      retryWindowMs: 10_000,
    });
    harness.setNow(0);
    const delivery = await worker.enqueue(invocation, peer);

    // First attempt at t=1s → defers.
    harness.setNow(1_000);
    await worker.tick();
    expect(harness.deliveries.get(delivery.id)?.status).toBe("deferred");

    // Second attempt past the retry window → terminal failure.
    harness.setNow(20_000);
    // Force the deferred entry to become eligible.
    const cur = harness.deliveries.get(delivery.id)!;
    harness.deliveries.set(delivery.id, {
      ...cur,
      metadata: { ...(cur.metadata ?? {}), nextAttemptAt: 19_000 },
    });
    await worker.tick();

    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
    expect(harness.failedInvocations).toHaveLength(1);
    expect(harness.failedInvocations[0]?.detail).toContain("attempts");
  });

  test("deferred entries are skipped before nextAttemptAt", async () => {
    const invocation = makeInvocation("inv-6", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    let calls = 0;
    harness.setForward(async (target) => {
      calls += 1;
      throw new PeerUnreachableError("down", targetErrorUrl(target));
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    harness.setNow(0);
    await worker.enqueue(invocation, peer);
    harness.setNow(100);
    await worker.tick();
    expect(calls).toBe(1);

    // Tick again before the next attempt window — should be a no-op.
    harness.setNow(200);
    await worker.tick();
    expect(calls).toBe(1);
  });

  test("missing peer URL defers without burning the retry budget", async () => {
    const invocation = makeInvocation("inv-7", "scout.main.mini");
    const peer = makeNode("mini-node"); // no brokerUrl
    const harness = makeHarness({ invocation, peer });

    harness.setForward(async () => {
      throw new Error("forward should not be called when peer URL is unknown");
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);

    // enqueue() captures peerBrokerUrl in metadata — strip it to simulate
    // the case where neither the registry nor the cached metadata have a URL.
    const stripped = harness.deliveries.get(delivery.id)!;
    harness.deliveries.set(delivery.id, {
      ...stripped,
      metadata: { ...(stripped.metadata ?? {}), peerBrokerUrl: undefined },
    });
    harness.setNode(makeNode("mini-node")); // still no URL

    await worker.tick();
    const stored = harness.deliveries.get(delivery.id);
    expect(stored?.status).toBe("deferred");
    expect(stored?.metadata?.failureReason).toBe("peer_unreachable");
  });

  test("notifyPeerOnline flushes deferred deliveries for that peer", async () => {
    const invocation = makeInvocation("inv-8", "scout.main.mini");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, peer });

    let online = false;
    harness.setForward(async (target) => {
      if (!online) throw new PeerUnreachableError("down", targetErrorUrl(target));
      return { ok: true, flight: {
        id: "flt-online",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: 0,
      } };
    });

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    const delivery = await worker.enqueue(invocation, peer);
    await worker.tick();
    expect(harness.deliveries.get(delivery.id)?.status).toBe("deferred");

    online = true;
    worker.notifyPeerOnline("mini-node");
    // notifyPeerOnline is fire-and-forget — give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.deliveries.get(delivery.id)?.status).toBe("peer_acked");
  });

  test("status mirror requests the remote-tier stream path, then the legacy path on 404", async () => {
    const invocation = makeInvocation("inv-mirror", "scout.main.mini");
    const agent = makeAgent("scout.main.mini", "mini-node");
    const peer = makeNode("mini-node", "http://10.0.0.2:65501");
    const harness = makeHarness({ invocation, agent, peer });

    const paths: string[] = [];
    // ensureStatusMirror is a no-op unless emit is wired, which is why the rest
    // of this file never exercises the stream path.
    harness.deps.emit = () => {};
    harness.deps.peerFetch = async (_baseUrl, path) => {
      paths.push(path);
      // 404 the first call so the pre-trust-cone fallback is exercised too.
      return new Response(null, { status: paths.length === 1 ? 404 : 204 });
    };

    harness.setForward(async () => ({
      ok: true as const,
      flight: {
        id: "flt-mirror",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: 0,
      },
    }));

    const worker = createPeerDeliveryWorker(harness.deps, { tickIntervalMs: 999_999 });
    await worker.enqueue(invocation, peer);
    await worker.tick();
    // The mirror is started in a floating async IIFE — let it reach both fetches.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(paths[0]).toBe("/v1/mesh/invocations/inv-mirror/stream");
    expect(paths[1]).toBe("/v1/invocations/inv-mirror/stream");
  });
});
