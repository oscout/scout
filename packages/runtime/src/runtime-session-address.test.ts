import { describe, expect, test } from "bun:test";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();

import type { ActorIdentity, AgentEndpoint, NodeDefinition } from "@openscout/protocol";
import { parseScoutComposerRouteTarget } from "@openscout/protocol";

import { buildBrokerReturnAddressForActor } from "./broker-conversation-helpers.js";
import { BrokerDeliveryRouter, buildDeliveryReceipt } from "./broker-delivery-routing.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";
import {
  endpointMatchesTargetSessionAddress,
  runtimeSessionAddressEntries,
  runtimeSessionAddressForEndpoint,
  runtimeSessionAddressForSessionId,
  runtimeSessionReachability,
  sessionHostNodeIds,
} from "./runtime-session-address.js";
import { resolveBrokerRouteTarget, type RuntimeSnapshot } from "./scout-dispatcher.js";

const LOCAL = "arts-mini-openscout";
const PEER = "mini-openscout";
const PEER_LEGACY = "mini-local-openscout";

function node(id: string, name: string): NodeDefinition {
  return { id, meshId: "openscout", name, hostName: name, advertiseScope: "mesh", registeredAt: 1 };
}

function sessionActor(id: string): ActorIdentity {
  return { id, kind: "session", displayName: id, handle: id, metadata: { cardless: true, handle: id } };
}

function endpoint(input: {
  id: string;
  agentId: string;
  nodeId: string;
  harness?: AgentEndpoint["harness"];
  state?: AgentEndpoint["state"];
  nativeSessionId?: string;
}): AgentEndpoint {
  return {
    id: input.id,
    agentId: input.agentId,
    nodeId: input.nodeId,
    harness: input.harness ?? "claude",
    transport: "claude_stream_json",
    state: input.state ?? "active",
    projectRoot: "/repo",
    cwd: "/repo",
    metadata: {
      cardless: true,
      handle: input.agentId,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    },
  };
}

function snapshotOf(endpoints: AgentEndpoint[]): RuntimeSnapshot {
  return {
    nodes: {
      [LOCAL]: node(LOCAL, "arts-mini.local"),
      [PEER]: node(PEER, "mini"),
      [PEER_LEGACY]: node(PEER_LEGACY, "mini"),
    },
    actors: Object.fromEntries(endpoints.map((item) => [item.agentId, sessionActor(item.agentId)])),
    agents: {},
    endpoints: Object.fromEntries(endpoints.map((item) => [item.id, item])),
    conversations: {},
    bindings: {},
    messages: {},
    readCursors: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
  } as unknown as RuntimeSnapshot;
}

const helpers = { isStale: () => false };
const local = endpoint({ id: "ep.local", agentId: "session-local", nodeId: LOCAL, nativeSessionId: "native-local" });
const peer = endpoint({ id: "ep.peer", agentId: "session-peer", nodeId: PEER, nativeSessionId: "native-peer" });
const localHandle = runtimeSessionHandleForEndpoint(local)!;
const peerHandle = runtimeSessionHandleForEndpoint(peer)!;

function resolve(snapshot: RuntimeSnapshot, address: string) {
  return resolveBrokerRouteTarget(snapshot, { target: parseScoutComposerRouteTarget(address) }, {
    preferLocalNodeId: LOCAL,
    helpers,
  });
}

describe("session addresses are derived for every known session", () => {
  test("address = broker handle @ stable host qualifier", () => {
    const snapshot = snapshotOf([local, peer]);
    expect(runtimeSessionAddressForEndpoint(snapshot, local)).toBe(`${localHandle}@arts-mini`);
    expect(runtimeSessionAddressForEndpoint(snapshot, peer)).toBe(`${peerHandle}@mini`);
    // Any accepted session selector yields the same copyable address.
    expect(runtimeSessionAddressForSessionId(snapshot, "native-local")).toBe(`${localHandle}@arts-mini`);
    expect(runtimeSessionAddressForSessionId(snapshot, localHandle)).toBe(`${localHandle}@arts-mini`);
    expect(runtimeSessionAddressForSessionId(snapshot, "unknown")).toBeNull();
  });

  test("a shared native alias across sessions never yields a guessed address", () => {
    const twin = endpoint({ id: "ep.twin", agentId: "session-twin", nodeId: LOCAL, nativeSessionId: "native-twin" });
    const snapshot = snapshotOf([
      { ...local, metadata: { ...local.metadata, tmuxSession: "shared" } },
      { ...twin, metadata: { ...twin.metadata, tmuxSession: "shared" } },
    ]);
    expect(runtimeSessionAddressForSessionId(snapshot, "shared")).toBeNull();
  });

  test("an address matches only its own host", () => {
    const snapshot = snapshotOf([local, peer]);
    expect(endpointMatchesTargetSessionAddress(snapshot, local, `${localHandle}@arts-mini`)).toBe(true);
    expect(endpointMatchesTargetSessionAddress(snapshot, local, `${localHandle}@mini`)).toBe(false);
    expect(endpointMatchesTargetSessionAddress(snapshot, local, "native-local")).toBe(true);
    expect(sessionHostNodeIds(snapshot, "mini")).toEqual([PEER_LEGACY, PEER]);
  });

  test("reachability is reported separately from addressability", () => {
    const resumable = endpoint({ id: "ep.off", agentId: "session-off", nodeId: LOCAL, state: "offline", nativeSessionId: "n-off" });
    const bare = endpoint({ id: "ep.bare", agentId: "session-bare", nodeId: LOCAL, state: "offline" });
    const ended = endpoint({ id: "ep.end", agentId: "session-end", nodeId: LOCAL, state: "stopped", nativeSessionId: "n-end" });
    const snapshot = snapshotOf([local, resumable, bare, ended]);
    expect(runtimeSessionReachability(snapshot, local)).toBe("live");
    expect(runtimeSessionReachability(snapshot, resumable)).toBe("resumable");
    expect(runtimeSessionReachability(snapshot, bare)).toBe("unavailable");
    expect(runtimeSessionReachability(snapshot, ended)).toBe("unavailable");
    expect(runtimeSessionAddressEntries(snapshot, [ended, resumable, local]).map((entry) => entry.reachability))
      .toEqual(["live", "resumable", "unavailable"]);
  });
});

describe("host-scoped exact session resolution", () => {
  test("resolves a local address to that exact cardless session", () => {
    const result = resolve(snapshotOf([local, peer]), `${localHandle}@arts-mini`);
    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") {
      expect(result.session.endpoint.id).toBe("ep.local");
      expect(result.session.nodeId).toBe(LOCAL);
    }
  });

  test("a projected remote session resolves with its authority node for forwarding", () => {
    const result = resolve(snapshotOf([local, peer]), `session:${peerHandle}@mini`);
    expect(result.kind).toBe("resolved_session");
    if (result.kind === "resolved_session") expect(result.session.nodeId).toBe(PEER);
  });

  test("the wrong host fails closed instead of substituting the session", () => {
    const result = resolve(snapshotOf([local, peer]), `${localHandle}@mini`);
    expect(result).toMatchObject({ kind: "unknown", sessionWakeReason: "session_not_on_host" });
    if (result.kind === "unknown") expect(result.detail).toContain("known on arts-mini");
  });

  test("an unknown host is reported, not guessed", () => {
    const result = resolve(snapshotOf([local]), `${localHandle}@nowhere`);
    expect(result).toMatchObject({ kind: "unknown", sessionWakeReason: "session_host_unknown" });
  });

  test("a known remote host that has not shared the session is reported honestly", () => {
    const result = resolve(snapshotOf([local]), `${peerHandle}@mini`);
    expect(result).toMatchObject({ kind: "unknown", sessionWakeReason: "session_host_not_projected" });
  });

  test("a local miss stays a plain unknown so the exact-session wake path can run", () => {
    const result = resolve(snapshotOf([local]), "sess.ffffffffffffffffffff@arts-mini");
    expect(result).toEqual({ kind: "unknown", label: "session:sess.ffffffffffffffffffff@arts-mini" });
  });

  test("selectors without a host behave exactly as before", () => {
    const result = resolveBrokerRouteTarget(snapshotOf([local, peer]), {
      target: { kind: "session_id", sessionId: peerHandle },
    }, { preferLocalNodeId: LOCAL, helpers });
    expect(result.kind).toBe("resolved_session");
  });

  test("the router never wakes a local look-alike for a foreign-host address", async () => {
    const snapshot = snapshotOf([local]);
    const wakes: string[] = [];
    const router = new BrokerDeliveryRouter({
      runtimeSnapshot: () => snapshot,
      nodeId: LOCAL,
      isInactiveLocalAgent: () => false,
      wakeExactHarnessSession: async (input) => {
        wakes.push(input.nativeSessionId);
        return { ok: false, reason: "session_unknown", detail: "not found" };
      },
    });
    const foreign = await router.resolveWithImplicitProjectAgent(
      { target: parseScoutComposerRouteTarget(`${peerHandle}@mini`) },
      { reason: "test" },
    );
    expect(foreign).toMatchObject({ kind: "unknown", sessionWakeReason: "session_host_not_projected" });
    expect(wakes).toEqual([]);

    const localMiss = await router.resolveWithImplicitProjectAgent(
      { target: parseScoutComposerRouteTarget("sess.ffffffffffffffffffff@arts-mini") },
      { reason: "test" },
    );
    expect(localMiss).toMatchObject({ kind: "unknown", sessionWakeReason: "session_unknown" });
    expect(wakes).toEqual(["sess.ffffffffffffffffffff"]);
  });
});

describe("reply continuity", () => {
  test("the requester's return address names its exact session address", () => {
    const snapshot = snapshotOf([local, peer]);
    expect(buildBrokerReturnAddressForActor(snapshot, "session-local").sessionAddress)
      .toBe(`${localHandle}@arts-mini`);
    // An explicit reply session wins over the actor's home endpoint.
    expect(buildBrokerReturnAddressForActor(snapshot, "session-local", { sessionId: "native-peer" }).sessionAddress)
      .toBe(`${peerHandle}@mini`);
    expect(buildBrokerReturnAddressForActor(snapshot, "session-local", { sessionId: "unknown" }).sessionAddress)
      .toBeUndefined();
  });

  test("delivery receipts carry the target session address only when known", () => {
    const base = {
      requestId: "deliver-1",
      routeKind: "dm" as const,
      requesterId: "session-peer",
      requesterNodeId: PEER,
      targetLabel: "repo:sess",
      conversationId: "dm.1",
      messageId: "msg-1",
    };
    expect(buildDeliveryReceipt({ ...base, targetSessionId: localHandle, targetSessionAddress: `${localHandle}@arts-mini` }))
      .toMatchObject({ targetSessionAddress: `${localHandle}@arts-mini` });
    expect("targetSessionAddress" in buildDeliveryReceipt(base)).toBe(false);
  });
});
