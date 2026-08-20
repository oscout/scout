import { describe, expect, test } from "bun:test";

import {
  namedChannelNaturalKey,
  type ActorIdentity,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
} from "@openscout/protocol";

import { BrokerHomeService } from "./broker-home-service.js";
import { brokerActorDisplayName } from "./broker-conversation-helpers.js";
import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import type { ActivityItem } from "./sqlite-store.js";

function actor(input: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    id: "operator",
    kind: "person",
    displayName: "Operator",
    handle: "operator",
    labels: [],
    metadata: {},
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "tmux",
    state: "idle",
    sessionId: "session-1",
    projectRoot: "/repo",
    metadata: {},
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "worker",
    state: "running",
    startedAt: 9_500,
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "channel.shared",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
    authorityNodeId: "node-local",
    participantIds: ["operator", "agent-1"],
    metadata: { channel: "shared", naturalKey: namedChannelNaturalKey("shared") },
    ...input,
  };
}

function activity(input: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    kind: "agent_message",
    ts: 1_000,
    messageId: "msg-1",
    actorId: "agent-1",
    conversationId: "channel.shared",
    title: "Agent update",
    summary: "Done",
    ...input,
  };
}

function createService(input: {
  snapshot: RuntimeRegistrySnapshot;
  activityItems?: ActivityItem[];
  operatorDisplayName?: string;
  now?: number;
}) {
  const listActivityCalls: Array<{ limit: number }> = [];
  const service = new BrokerHomeService({
    runtimeSnapshot: () => input.snapshot,
    listActivityItems: async (options) => {
      listActivityCalls.push(options);
      return input.activityItems ?? [];
    },
    actorDisplayName: (snapshot, actorId) => brokerActorDisplayName(snapshot, actorId, {
      operatorActorId: "operator",
      operatorDisplayName: input.operatorDisplayName ?? "Operator",
    }),
    operatorActorId: "operator",
    now: () => input.now ?? 10_000,
  });
  return { service, listActivityCalls };
}

describe("broker home service", () => {
  test("builds ordered agent cards and excludes inactive local registrations", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        worker: agent({
          id: "worker",
          displayName: "Worker",
          metadata: { role: "reviewer", summary: "Reviews code" },
        }),
        helper: agent({ id: "helper", displayName: "Helper" }),
        offline: agent({
          id: "offline",
          displayName: "Offline",
          metadata: { projectRoot: "/offline-repo" },
        }),
        stale: agent({
          id: "stale",
          displayName: "Stale",
          metadata: { staleLocalRegistration: true },
        }),
        retired: agent({
          id: "retired",
          displayName: "Retired",
          metadata: { retiredFromFleet: true },
        }),
      },
      endpoints: {
        worker: endpoint({
          id: "worker-endpoint",
          agentId: "worker",
          state: "active",
          projectRoot: "/worker-repo",
          metadata: { lastStartedAt: 9_000 },
        }),
        helper: endpoint({
          id: "helper-endpoint",
          agentId: "helper",
          state: "idle",
          projectRoot: undefined,
          cwd: "/helper-repo",
          metadata: { lastStartedAt: 8_000 },
        }),
      },
      flights: {
        worker: flight(),
      },
    });
    const { service } = createService({ snapshot });

    const home = await service.read();

    expect(home.updatedAt).toBe(10_000);
    expect(home.agents.map((agentCard) => agentCard.id)).toEqual([
      "worker",
      "helper",
      "offline",
    ]);
    expect(home.agents[0]).toEqual(expect.objectContaining({
      title: "Worker",
      role: "reviewer",
      summary: "Reviews code",
      projectRoot: "/worker-repo",
      state: "working",
      reachable: true,
      statusLabel: "Working",
      lastSeenAt: 9_000,
    }));
    expect(home.agents[1]).toEqual(expect.objectContaining({
      projectRoot: "/helper-repo",
      state: "available",
      statusLabel: "Available",
    }));
    expect(home.agents[2]).toEqual(expect.objectContaining({
      projectRoot: "/offline-repo",
      state: "offline",
      reachable: false,
      statusLabel: "Offline",
    }));
  });

  test("does not keep an attached agent working after its flight completes", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        worker: agent({ id: "worker", displayName: "Worker" }),
      },
      endpoints: {
        worker: endpoint({
          id: "worker-endpoint",
          agentId: "worker",
          state: "active",
        }),
      },
      flights: {
        worker: flight({
          targetAgentId: "worker",
          state: "completed",
          completedAt: 9_900,
        }),
      },
    });
    const { service } = createService({ snapshot });

    const home = await service.read();

    expect(home.agents[0]).toEqual(expect.objectContaining({
      id: "worker",
      state: "available",
      reachable: true,
      statusLabel: "Available",
    }));
  });

  test("projects flight state for agent rows beyond the old 24-card home cutoff", async () => {
    const agents = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => {
        const id = `agent-${String(index).padStart(2, "0")}`;
        return [id, agent({ id, displayName: `Agent ${index}` })];
      }),
    );
    const endpoints = Object.fromEntries(
      Object.keys(agents).map((id) => [
        id,
        endpoint({
          id: `${id}-endpoint`,
          agentId: id,
          state: "active",
        }),
      ]),
    );
    const snapshot = createRuntimeRegistrySnapshot({ agents, endpoints });
    const { service } = createService({ snapshot });

    const home = await service.read();

    expect(home.agents).toHaveLength(30);
    expect(home.agents.every((entry) => entry.state === "available")).toBe(true);
  });

  test("shapes recent message activity and filters non-home rows", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      actors: {
        operator: actor({ displayName: "Configured Operator" }),
      },
      agents: {
        "agent-1": agent(),
      },
      conversations: {
        "channel.shared": conversation(),
        "channel.docs": conversation({
          id: "channel.docs",
          title: "docs",
          metadata: { channel: "docs", naturalKey: namedChannelNaturalKey("docs") },
        }),
      },
    });
    const { service, listActivityCalls } = createService({
      snapshot,
      operatorDisplayName: "Arach",
      activityItems: [
        activity({
          id: "stale-flight",
          kind: "flight_updated",
          messageId: "msg-stale",
          summary: "Stale running flight reconciled: endpoint disappeared",
        }),
        activity({
          id: "no-message",
          kind: "invocation_recorded",
          messageId: undefined,
        }),
        activity({
          id: "status-row",
          kind: "status_message",
          messageId: "msg-status",
          title: "Stored",
          summary: "Will deliver when online.",
        }),
        activity({
          id: "operator-row",
          actorId: undefined,
          conversationId: "channel.docs",
          messageId: "msg-operator",
          title: undefined,
          summary: "Manual update",
          ts: 2_000,
        }),
      ],
    });

    const home = await service.read();

    expect(listActivityCalls).toEqual([{ limit: 96 }]);
    expect(home.activity).toEqual([
      {
        id: "msg-status",
        kind: "system",
        actorId: "agent-1",
        actorName: "Agent One",
        title: "Stored",
        detail: "Will deliver when online.",
        conversationId: "channel.shared",
        channel: "shared",
        timestamp: 1_000,
      },
      {
        id: "msg-operator",
        kind: "message",
        actorId: "operator",
        actorName: "Arach",
        title: "Arach",
        detail: "Manual update",
        conversationId: "channel.docs",
        channel: "docs",
        timestamp: 2_000,
      },
    ]);
  });
});
