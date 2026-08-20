import { describe, expect, test } from "bun:test";

import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import {
  createRuntimeRegistrySnapshot,
  queryRuntimeRegistrySnapshot,
} from "./registry.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function actor(id: string): ActorIdentity {
  return { id, kind: "person", displayName: id };
}

function agent(id: string, metadata: Record<string, unknown> = {}): AgentDefinition {
  return {
    id,
    kind: "agent",
    displayName: id,
    definitionId: `definition.${id}`,
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ownerId: "operator",
    metadata,
  };
}

function endpoint(
  id: string,
  agentId: string,
  state: AgentEndpoint["state"],
  metadata: Record<string, unknown> = {},
): AgentEndpoint {
  return {
    id,
    agentId,
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state,
    metadata,
  };
}

function conversation(id: string, participantIds: string[], createdAt?: number): ConversationDefinition {
  return {
    id,
    kind: "direct",
    title: id,
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds,
    ...(createdAt !== undefined ? { metadata: { createdAt } } : {}),
  };
}

function message(id: string, conversationId: string, actorId: string, createdAt: number): MessageRecord {
  return {
    id,
    conversationId,
    actorId,
    originNodeId: "node-1",
    class: "agent",
    body: id,
    visibility: "private",
    policy: "durable",
    createdAt,
  };
}

function invocation(id: string, targetAgentId: string, createdAt: number): InvocationRequest {
  return {
    id,
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId,
    action: "execute",
    task: id,
    ensureAwake: true,
    stream: false,
    createdAt,
  };
}

function flight(
  id: string,
  invocationId: string,
  targetAgentId: string,
  state: FlightRecord["state"],
  completedAt?: number,
): FlightRecord {
  return {
    id,
    invocationId,
    requesterId: "operator",
    targetAgentId,
    state,
    completedAt,
  };
}

describe("queryRuntimeRegistrySnapshot", () => {
  test("keeps a coherent current and recent working set", () => {
    const now = 10 * DAY_MS;
    const since = now - DAY_MS;
    const snapshot = createRuntimeRegistrySnapshot({
      nodes: {
        "node-1": {
          id: "node-1",
          meshId: "mesh-1",
          name: "Node 1",
          advertiseScope: "local",
          registeredAt: 1,
        },
      },
      actors: {
        operator: actor("operator"),
        current: agent("current"),
        stale: agent("stale", { staleLocalRegistration: true }),
        recent: agent("recent", { staleLocalRegistration: true }),
      },
      agents: {
        current: agent("current"),
        stale: agent("stale", { staleLocalRegistration: true }),
        recent: agent("recent", { staleLocalRegistration: true }),
      },
      endpoints: {
        "endpoint-current": endpoint("endpoint-current", "current", "active", { lastSeenAt: 1 }),
        "endpoint-stale": endpoint("endpoint-stale", "stale", "offline", {
          staleLocalRegistration: true,
          lastSeenAt: 1,
        }),
      },
      conversations: {
        recent: conversation("recent", ["operator", "recent"], since + 1),
        old: conversation("old", ["operator", "stale"], since - 1),
      },
      messages: {
        recent: message("recent", "recent", "recent", since + 1),
        old: message("old", "old", "stale", since - 1),
      },
      invocations: {
        active: invocation("active", "recent", since - 1),
        old: invocation("old", "stale", since - 1),
      },
      flights: {
        active: flight("active", "active", "recent", "running"),
        old: flight("old", "old", "stale", "completed", since - 1),
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, { since });

    expect(Object.keys(result.agents).sort()).toEqual(["current", "recent"]);
    expect(Object.keys(result.endpoints)).toEqual(["endpoint-current"]);
    expect(Object.keys(result.messages)).toEqual(["recent"]);
    expect(Object.keys(result.conversations)).toEqual(["recent"]);
    expect(Object.keys(result.invocations)).toEqual(["active"]);
    expect(Object.keys(result.flights)).toEqual(["active"]);
    expect(Object.keys(result.actors).sort()).toEqual(["current", "operator", "recent"]);
  });

  test("returns the full snapshot when no cutoff is supplied", () => {
    const snapshot = createRuntimeRegistrySnapshot();
    expect(queryRuntimeRegistrySnapshot(snapshot)).toBe(snapshot);
  });

  test("retains conversations that carry no timestamp at all", () => {
    // Records written before timestamps were stamped must stay visible to
    // incremental snapshots or every send to them fails downstream.
    const since = 10 * DAY_MS;
    const snapshot = createRuntimeRegistrySnapshot({
      actors: { operator: actor("operator") },
      conversations: {
        legacy: conversation("legacy", ["operator", "legacy"]),
        old: conversation("old", ["operator", "old"], since - 1),
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, { since });

    expect(Object.keys(result.conversations)).toEqual(["legacy"]);
  });
});
