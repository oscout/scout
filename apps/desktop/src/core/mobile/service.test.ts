import { afterEach, describe, expect, test } from "bun:test";

import {
  registerActiveScoutBrokerService,
  type ActiveScoutBrokerService,
} from "@openscout/runtime/broker-api";

import {
  getScoutMobileAgents,
  getScoutMobileRuntimeCapabilities,
  getScoutMobileActivity,
  getScoutMobileConversations,
  getScoutMobileServiceBudgets,
  getScoutMobileSessionSnapshot,
  getScoutMobileTerminals,
  rehomeScoutMobileWorkspacePath,
} from "./service.ts";

const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
afterEach(() => {
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  registerActiveScoutBrokerService(null);
});

test("transitional mobile gauges keep stable empty compatibility shapes", async () => {
  expect(await getScoutMobileServiceBudgets()).toEqual({ budgets: [] });
  expect(await getScoutMobileTerminals()).toEqual({ terminals: [] });
});

test("mobile runtime capabilities hide the duplicate Grok harness", async () => {
  const catalog = await getScoutMobileRuntimeCapabilities();
  expect(catalog.harnesses.map((harness) => harness.id)).not.toContain("grok");
  expect(catalog.harnesses.map((harness) => harness.id)).toContain("grok-acp");
});

describe("getScoutMobileSessionSnapshot", () => {
  test("rebases stale macOS account paths onto the current Scout home", () => {
    expect(rehomeScoutMobileWorkspacePath("/Users/arach/dev/dewey", "/Users/art"))
      .toBe("/Users/art/dev/dewey");
    expect(rehomeScoutMobileWorkspacePath("/opt/projects/dewey", "/Users/art"))
      .toBe(null);
  });

  test("does not render queued delivery flights as assistant thinking turns", async () => {
    installBrokerSnapshot(
      brokerSnapshotWithFlight({
        id: "flight-queued",
        state: "queued",
        summary: "Message stored for Scout. Will deliver when online.",
      }),
    );

    const snapshot = await getScoutMobileSessionSnapshot("dm.operator.scoutbot");

    expect(snapshot.turns.map((turn) => turn.id)).toEqual(["msg-user"]);
    expect(snapshot.currentTurnId).toBe(null);
  });

  test("renders running flights as assistant working turns", async () => {
    installBrokerSnapshot(
      brokerSnapshotWithFlight({
        id: "flight-running",
        state: "running",
        summary: "Working on it.",
      }),
    );

    const snapshot = await getScoutMobileSessionSnapshot("dm.operator.scoutbot");

    expect(snapshot.turns.map((turn) => turn.id)).toEqual([
      "msg-user",
      "flight:flight-running",
    ]);
    expect(snapshot.currentTurnId).toBe("flight:flight-running");
    expect(snapshot.turns.at(-1)?.blocks[0]?.block.text).toBe("Working on it.");
  });

  test("hides requester wait timeout statuses from mobile message pages", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-requester-timeout",
      state: "waiting",
      summary: "Scout is still working; Scout stopped waiting for a synchronous result after 300000ms.",
      metadata: {
        requesterTimedOut: true,
        timeoutScope: "requester_wait",
      },
    });
    (brokerSnapshot.messages as Record<string, unknown>)["msg-timeout-status"] = {
      id: "msg-timeout-status",
      conversationId: "dm.operator.scoutbot",
      actorId: "scout",
      class: "status",
      body: "Scout is still working; Scout stopped waiting for a synchronous result after 300000ms.",
      visibility: "private",
      policy: "durable",
      createdAt: 2_500,
      metadata: {
        source: "broker",
        invocationId: "inv-flight-requester-timeout",
        flightId: "flight-requester-timeout",
      },
    };
    installBrokerSnapshot(brokerSnapshot);

    const snapshot = await getScoutMobileSessionSnapshot("dm.operator.scoutbot");

    expect(snapshot.turns.map((turn) => turn.id)).toEqual(["msg-user"]);
    expect(snapshot.currentTurnId).toBe(null);
  });

  test("falls back when a resolved conversation has no title", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-running",
      state: "running",
      summary: "Working on it.",
    });
    delete (brokerSnapshot.conversations["dm.operator.scoutbot"] as { title?: string }).title;
    installBrokerSnapshot(brokerSnapshot);

    const snapshot = await getScoutMobileSessionSnapshot("dm.operator.scoutbot");

    expect(snapshot.session.name).toBe("Scout");
  });

  test("falls back when a comms conversation has no title", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-running",
      state: "running",
      summary: "Working on it.",
    });
    delete (brokerSnapshot.conversations["dm.operator.scoutbot"] as { title?: string }).title;
    installBrokerSnapshot(brokerSnapshot);

    const conversations = await getScoutMobileConversations();

    expect(conversations.find((conversation) => conversation.id === "dm.operator.scoutbot")?.title).toBe("Scout");
  });

  test("builds Home activity from broker-mediated conversation messages", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-running",
      state: "running",
      summary: "Working on it.",
    });
    (brokerSnapshot.messages as Record<string, unknown>)["msg-agent"] = {
      id: "msg-agent",
      conversationId: "dm.operator.scoutbot",
      actorId: "scoutbot",
      class: "agent",
      body: "Finished the requested change.",
      visibility: "private",
      policy: "durable",
      createdAt: 2_000,
    };
    installBrokerSnapshot(brokerSnapshot);

    const activity = await getScoutMobileActivity({ limit: 2 });

    expect(activity.map((row) => row.id)).toEqual(["msg-agent", "msg-user"]);
    expect(activity[0]).toMatchObject({
      kind: "message",
      actorId: "scoutbot",
      actorName: "Scout",
      detail: "Finished the requested change.",
      conversationId: "dm.operator.scoutbot",
    });
  });

  test("orders agents by endpoint freshness and keeps wakeable cold agents available", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-queued",
      state: "queued",
      summary: "Queued",
    }) as ReturnType<typeof brokerSnapshotWithFlight> & {
      agents: Record<string, Record<string, unknown>>;
      endpoints: Record<string, Record<string, unknown>>;
      messages: Record<string, Record<string, unknown>>;
      flights: Record<string, Record<string, unknown>>;
    };
    brokerSnapshot.flights = {};
    brokerSnapshot.endpoints["endpoint-scoutbot"] = {
      ...brokerSnapshot.endpoints["endpoint-scoutbot"],
      state: "offline",
      metadata: { source: "scoutbot", lastCompletedAt: 10_000 } as { source: string } & Record<string, unknown>,
    };
    brokerSnapshot.agents.old = {
      id: "old",
      kind: "agent",
      definitionId: "old",
      displayName: "Old",
      handle: "old",
      wakePolicy: "manual",
    };
    brokerSnapshot.endpoints["endpoint-old"] = {
      id: "endpoint-old",
      agentId: "old",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "active",
      metadata: { lastSeenAt: 5_000 },
    };
    brokerSnapshot.messages["msg-old"] = {
      id: "msg-old",
      conversationId: "dm.operator.scoutbot",
      actorId: "old",
      class: "agent",
      body: "older activity",
      visibility: "private",
      policy: "durable",
      createdAt: 9_000,
    };
    installBrokerSnapshot(brokerSnapshot);

    const agents = await getScoutMobileAgents({ limit: 2 });

    expect(agents.map((agent) => agent.id)).toEqual(["scoutbot", "old"]);
    expect(agents[0]?.state).toBe("available");
    expect(agents[0]?.lastActiveAt).toBe(10_000_000);
  });

  test("uses the live endpoint and newest activity when an agent has stale registrations", async () => {
    const brokerSnapshot = brokerSnapshotWithFlight({
      id: "flight-queued",
      state: "queued",
      summary: "Queued",
    }) as ReturnType<typeof brokerSnapshotWithFlight> & {
      endpoints: Record<string, Record<string, unknown>>;
      flights: Record<string, Record<string, unknown>>;
    };
    brokerSnapshot.flights = {};
    brokerSnapshot.endpoints["endpoint-scoutbot"] = {
      ...brokerSnapshot.endpoints["endpoint-scoutbot"],
      harness: "codex",
      state: "idle",
      metadata: { source: "scoutbot", lastSeenAt: 1_000 } as { source: string } & Record<string, unknown>,
    };
    brokerSnapshot.endpoints["endpoint-scoutbot-live"] = {
      id: "endpoint-scoutbot-live",
      agentId: "scoutbot",
      nodeId: "node-1",
      harness: "claude",
      transport: "claude_session",
      state: "active",
      projectRoot: "/Users/art/dev/openscout",
      metadata: { lastSeenAt: 20_000 },
    };
    installBrokerSnapshot(brokerSnapshot);

    const [agent] = await getScoutMobileAgents({ limit: 1 });

    expect(agent?.harness).toBe("claude");
    expect(agent?.workspaceRoot).toBe("/Users/art/dev/openscout");
    expect(agent?.state).toBe("available");
    expect(agent?.lastActiveAt).toBe(20_000_000);
  });
});

function brokerSnapshotWithFlight(flight: {
  id: string;
  state: "queued" | "running" | "waiting";
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    actors: {},
    agents: {
      scoutbot: {
        id: "scoutbot",
        kind: "agent",
        definitionId: "scoutbot",
        displayName: "Scout",
        handle: "scoutbot",
      },
    },
    endpoints: {
      "endpoint-scoutbot": {
        id: "endpoint-scoutbot",
        agentId: "scoutbot",
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
        state: "active",
        metadata: { source: "scoutbot" },
      },
    },
    conversations: {
      "dm.operator.scoutbot": {
        id: "dm.operator.scoutbot",
        kind: "direct",
        title: "Scout",
        visibility: "private",
        shareMode: "local",
        participantIds: ["operator", "scoutbot"],
      },
    },
    messages: {
      "msg-user": {
        id: "msg-user",
        conversationId: "dm.operator.scoutbot",
        actorId: "operator",
        class: "agent",
        body: "/recent",
        visibility: "private",
        policy: "durable",
        createdAt: 1_000,
      },
    },
    flights: {
      [flight.id]: {
        id: flight.id,
        invocationId: `inv-${flight.id}`,
        requesterId: "operator",
        targetAgentId: "scoutbot",
        state: flight.state,
        summary: flight.summary,
        startedAt: 2_000,
        metadata: flight.metadata,
      },
    },
    nodes: {
      "node-1": { id: "node-1", name: "Test Mac" },
    },
  };
}

function installBrokerSnapshot(snapshot: unknown) {
  process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
  registerActiveScoutBrokerService({
    baseUrl: "http://broker.test",
    readHealth: async () => ({
      ok: true,
      nodeId: "node-1",
      meshId: "mesh-1",
      counts: null,
    }),
    readNode: async () => ({ id: "node-1", name: "Test Mac" }) as never,
    readSnapshot: async () => snapshot as never,
    executeCommand: async () => ({ ok: true }),
  } satisfies ActiveScoutBrokerService);
}
