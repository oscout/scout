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
  test("returns only agents for mesh roster synchronization", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      actors: { participant: actor("participant") },
      agents: { participant: agent("participant") },
      endpoints: {
        "endpoint-participant": endpoint("endpoint-participant", "participant", "active"),
      },
      conversations: {
        recent: conversation("recent", ["participant"], 10),
      },
      messages: {
        recent: message("recent", "recent", "participant", 10),
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, { scope: "agents" });

    expect(result.agents).toEqual(snapshot.agents);
    expect(result.agents).not.toBe(snapshot.agents);
    expect(result.actors).toEqual({});
    expect(result.endpoints).toEqual({});
    expect(result.conversations).toEqual({});
    expect(result.messages).toEqual({});
  });

  test("conversation scope omits unrelated current agent registrations", () => {
    const snapshot = createRuntimeRegistrySnapshot({
      actors: {
        operator: actor("operator"),
        participant: agent("participant"),
        unrelated: agent("unrelated"),
      },
      agents: {
        participant: agent("participant"),
        unrelated: agent("unrelated"),
      },
      endpoints: {
        "endpoint-participant": endpoint("endpoint-participant", "participant", "active"),
        "endpoint-unrelated": endpoint("endpoint-unrelated", "unrelated", "active"),
      },
      conversations: {
        recent: conversation("recent", ["operator", "participant"], 10),
      },
      messages: {
        recent: message("recent", "recent", "participant", 10),
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, {
      since: 1,
      scope: "conversations",
    });

    expect(Object.keys(result.agents)).toEqual(["participant"]);
    expect(Object.keys(result.endpoints)).toEqual(["endpoint-participant"]);
    expect(Object.keys(result.actors).sort()).toEqual(["operator", "participant"]);
  });

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

  test("keeps active-flight invocations beyond the per-conversation history cap", () => {
    const activeInvocation = {
      ...invocation("active", "participant", 1),
      conversationId: "channel",
    };
    const completedInvocations = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const id = `completed-${index}`;
        return [id, {
          ...invocation(id, "participant", index + 2),
          conversationId: "channel",
        }];
      }),
    );
    const completedFlights = Object.fromEntries(
      Object.keys(completedInvocations).map((id, index) => [
        id,
        flight(id, id, "participant", "completed", index + 2),
      ]),
    );
    const snapshot = createRuntimeRegistrySnapshot({
      actors: { operator: actor("operator"), participant: agent("participant") },
      agents: { participant: agent("participant") },
      conversations: {
        channel: {
          ...conversation("channel", ["operator", "participant"], 1),
          kind: "channel",
        },
      },
      invocations: { active: activeInvocation, ...completedInvocations },
      flights: {
        active: flight("active", "active", "participant", "running"),
        ...completedFlights,
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, { since: 1, scope: "conversations" });

    expect(result.invocations.active?.id).toBe("active");
    expect(result.flights.active?.state).toBe("running");
    expect(Object.keys(result.invocations)).toHaveLength(13);
  });

  test("keeps live channel participants beyond the rich-roster cap", () => {
    const participantIds = ["operator", ...Array.from({ length: 33 }, (_, index) => `agent-${index}`)];
    const liveAgentId = participantIds.at(-1)!;
    const participantAgents = Object.fromEntries(
      participantIds.slice(1).map((id) => [id, agent(id)]),
    );
    const snapshot = createRuntimeRegistrySnapshot({
      actors: { operator: actor("operator"), ...participantAgents },
      agents: participantAgents,
      endpoints: {
        live: endpoint("live", liveAgentId, "active"),
      },
      conversations: {
        channel: {
          ...conversation("channel", participantIds, 1),
          kind: "channel",
        },
      },
      messages: {
        recent: message("recent", "channel", "operator", 2),
      },
    });

    const result = queryRuntimeRegistrySnapshot(snapshot, { since: 1, scope: "conversations" });

    expect(result.actors[liveAgentId]?.id).toBe(liveAgentId);
    expect(result.agents[liveAgentId]?.id).toBe(liveAgentId);
    expect(result.endpoints.live?.agentId).toBe(liveAgentId);
  });
});
