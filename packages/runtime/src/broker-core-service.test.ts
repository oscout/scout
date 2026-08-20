import { describe, expect, test } from "bun:test";

import type { ScoutBrokerProjectionStatus } from "./broker-api.js";
import { createBrokerCoreService } from "./broker-core-service.js";
import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import type { ActivityItem } from "./sqlite-store.js";

function createReadOnlyBrokerCoreService(
  snapshot: RuntimeRegistrySnapshot,
  projectionStatus?: ScoutBrokerProjectionStatus,
) {
  return createBrokerCoreService({
    baseUrl: "http://broker.test",
    nodeId: "node-1",
    meshId: "mesh-1",
    localNode: {
      id: "node-1",
      meshId: "mesh-1",
      name: "node-1",
      advertiseScope: "local",
      registeredAt: 1,
      lastSeenAt: 1,
    },
    runtime: {
      snapshot: () => snapshot,
    },
    projection: {
      listActivityItems: async () => [],
    },
    journal: {
      listCollaborationRecords: () => [],
      listCollaborationEvents: () => [],
      listDeliveries: () => [],
      listDeliveryAttempts: () => [],
      listScoutDispatches: () => [],
    },
    threadEvents: {
      replay: async () => [],
      snapshot: async (conversationId) => ({
        conversation: {
          id: conversationId,
          kind: "direct",
          authorityNodeId: "node-1",
          participantIds: [],
          visibility: "private",
          createdAt: 1,
          updatedAt: 1,
        },
        latestSeq: 0,
        messages: [],
        collaboration: [],
        activeFlights: [],
      }),
      openWatch: async (request) => ({
        watchId: `${request.watcherId}-watch`,
        conversationId: request.conversationId,
        authorityNodeId: "node-1",
        acceptedAfterSeq: request.afterSeq ?? 0,
        latestSeq: 0,
        leaseExpiresAt: 999,
        mode: "snapshot_then_stream",
      }),
      renewWatch: async (request) => ({
        watchId: request.watchId,
        leaseExpiresAt: 999,
      }),
      closeWatch: async () => {},
    },
    isReconciledStaleFlightActivityItem: () => false,
    ...(projectionStatus
      ? { readProjectionStatus: () => projectionStatus }
      : {}),
    executeCommand: async () => ({ ok: true }),
  });
}

describe("createBrokerCoreService", () => {
  test("includes projection status in broker health without changing broker readiness", async () => {
    const projection = {
      state: "degraded",
      detail: "database schema is newer than this runtime",
    } satisfies ScoutBrokerProjectionStatus;

    const health = await createReadOnlyBrokerCoreService(
      createRuntimeRegistrySnapshot(),
      projection,
    ).readHealth();

    expect(health.ok).toBe(true);
    expect(health.projection).toEqual(projection);
  });

  test("builds broker reads around runtime state and delegates writes", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      messages: {
        "msg-1": {
          id: "msg-1",
          conversationId: "conv-1",
          actorId: "agent-1",
          originNodeId: "node-1",
          class: "agent",
          body: "hello",
          visibility: "workspace",
          policy: "durable",
          createdAt: 100,
        },
      },
      collaborationRecords: {
        "rec-1": {
          id: "rec-1",
          kind: "task",
          title: "Investigate",
          createdById: "agent-1",
          createdAt: 100,
          updatedAt: 100,
        },
      },
    });

    const activityItems: ActivityItem[] = [
      {
        id: "act-1",
        kind: "message_posted",
        ts: 100,
        agentId: "agent-1",
        messageId: "msg-1",
        title: "hello",
      },
      {
        id: "act-2",
        kind: "flight_updated",
        ts: 101,
        flightId: "flt-1",
      },
    ];
    const commands: unknown[] = [];
    const delivered: string[] = [];
    let capabilitiesQuery: { force?: boolean } | undefined;

    const service = createBrokerCoreService({
      baseUrl: "http://broker.test",
      nodeId: "node-1",
      meshId: "mesh-1",
      localNode: {
        id: "node-1",
        meshId: "mesh-1",
        name: "node-1",
        advertiseScope: "local",
        registeredAt: 1,
        lastSeenAt: 1,
      },
      runtime: {
        snapshot: () => snapshot,
      },
      projection: {
        listActivityItems: async () => activityItems,
      },
      journal: {
        listCollaborationRecords: () => Object.values(snapshot.collaborationRecords),
        listCollaborationEvents: () => [],
        listDeliveries: () => [],
        listDeliveryAttempts: () => [],
        listScoutDispatches: () => [],
      },
      threadEvents: {
        replay: async () => [],
        snapshot: async () => ({
          conversation: {
            id: "conv-1",
            kind: "direct",
            authorityNodeId: "node-1",
            participantIds: ["agent-1"],
            visibility: "workspace",
            createdAt: 100,
            updatedAt: 100,
          },
          latestSeq: 0,
          messages: [],
          collaboration: [],
          activeFlights: [],
        }),
        openWatch: async (request) => ({
          watchId: `${request.watcherId}-watch`,
          conversationId: request.conversationId,
          authorityNodeId: "node-1",
          acceptedAfterSeq: request.afterSeq ?? 0,
          latestSeq: 0,
          leaseExpiresAt: 999,
          mode: "snapshot_then_stream",
        }),
        renewWatch: async (request) => ({
          watchId: request.watchId,
          leaseExpiresAt: 999,
        }),
        closeWatch: async () => {},
      },
      isReconciledStaleFlightActivityItem: (item) => item.id === "act-2",
      build: {
        packageName: "@openscout/runtime",
        version: "0.test",
        commit: "abc123",
        branch: "lane-c",
        buildNumber: "42",
        mode: "dev",
      },
      readChildServices: () => ({
        web: {
          managed: true,
          managedBy: "broker",
          state: "running",
          pid: 4242,
          port: 43120,
          url: "http://127.0.0.1:43120",
          healthy: null,
        },
      }),
      readCapabilities: async (query) => {
        capabilitiesQuery = query;
        return {
          generatedAt: 123,
          scope: { machineId: "node-1" },
          sources: [{
            kind: "harness_adapter",
            id: "codex",
            capturedAt: 123,
          }],
          capabilities: [],
          warnings: [],
        };
      },
      executeCommand: async (command) => {
        commands.push(command);
        return { ok: true };
      },
      deliver: async (request) => {
        delivered.push(request.id);
        return {
          kind: "delivery",
          accepted: true,
          routeKind: "dm",
          conversation: {
            id: "conv-1",
            kind: "direct",
            title: "Conversation",
            visibility: "private",
            shareMode: "local",
            authorityNodeId: "node-1",
            participantIds: ["agent-1"],
          },
          message: {
            id: "msg-deliver-1",
            conversationId: "conv-1",
            actorId: request.requesterId,
            originNodeId: request.requesterNodeId,
            class: "agent",
            body: request.body,
            visibility: "private",
            policy: "durable",
            createdAt: request.createdAt,
          },
          targetAgentId: request.targetAgentId,
        };
      },
    });

    const health = await service.readHealth();
    const capabilities = await service.readCapabilities?.({ force: true });
    const capabilityAvailability = await service.readCapabilityAvailability?.({
      capabilityId: "cap:missing",
      methodName: "call",
      requireReady: true,
      force: true,
    });
    const messages = await service.readMessages?.({ limit: 10 });
    const activity = await service.readActivity?.({ limit: 10 });
    const records = await service.readCollaborationRecords?.({ limit: 10 });
    const closeWatch = await service.closeThreadWatch?.({ watchId: "watch-1" });
    const delivery = await service.deliver?.({
      id: "deliver-1",
      requesterId: "agent-1",
      requesterNodeId: "node-1",
      body: "deliver this",
      intent: "tell",
      targetAgentId: "agent-2",
      createdAt: 102,
    });
    const post = await service.postConversationMessage?.({
      id: "msg-2",
      conversationId: "conv-1",
      actorId: "agent-1",
      originNodeId: "node-1",
      class: "agent",
      body: "next",
      visibility: "workspace",
      policy: "durable",
      createdAt: 101,
    });

    expect(health.counts?.messages).toBe(1);
    expect(health.counts?.collaborationRecords).toBe(1);
    expect(health.build).toEqual({
      packageName: "@openscout/runtime",
      version: "0.test",
      commit: "abc123",
      branch: "lane-c",
      buildNumber: "42",
      mode: "dev",
    });
    expect(health.services?.web).toEqual({
      managed: true,
      managedBy: "broker",
      state: "running",
      pid: 4242,
      port: 43120,
      url: "http://127.0.0.1:43120",
      healthy: null,
    });
    expect(capabilities).toEqual({
      generatedAt: 123,
      scope: { machineId: "node-1" },
      sources: [{
        kind: "harness_adapter",
        id: "codex",
        capturedAt: 123,
      }],
      capabilities: [],
      warnings: [],
    });
    expect(capabilitiesQuery).toEqual({ force: true });
    expect(capabilityAvailability).toEqual({
      decision: "deny",
      capabilityId: "cap:missing",
      reason: "capability_missing",
      detail: "Capability is not present in the current matrix snapshot.",
    });
    expect(messages?.map((message) => message.id)).toEqual(["msg-1"]);
    expect(activity?.map((item) => item.id)).toEqual(["act-1"]);
    expect(records).toEqual(Object.values(snapshot.collaborationRecords));
    expect(closeWatch).toEqual({ ok: true, watchId: "watch-1" });
    expect(delivery).toEqual(expect.objectContaining({
      kind: "delivery",
      targetAgentId: "agent-2",
    }));
    expect(post).toEqual({ ok: true });
    expect(delivered).toEqual(["deliver-1"]);
    expect(commands).toEqual([
      {
        kind: "conversation.post",
        message: expect.objectContaining({ id: "msg-2" }),
      },
    ]);
  });

  test("keeps requester wait timeouts out of message reads but exposes the flight as a warning", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "agent-1": {
          id: "agent-1",
          kind: "agent",
          definitionId: "agent-1",
          displayName: "Agent One",
          agentClass: "general",
          capabilities: ["chat", "invoke"],
          wakePolicy: "on_demand",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      conversations: {
        "conv-1": {
          id: "conv-1",
          kind: "direct",
          title: "Agent One",
          authorityNodeId: "node-1",
          participantIds: ["operator", "agent-1"],
          visibility: "private",
          shareMode: "local",
        },
      },
      messages: {
        "msg-1": {
          id: "msg-1",
          conversationId: "conv-1",
          actorId: "operator",
          originNodeId: "node-1",
          class: "agent",
          body: "please review this",
          audience: { notify: ["agent-1"] },
          visibility: "private",
          policy: "durable",
          createdAt: 100,
        },
        "msg-timeout": {
          id: "msg-timeout",
          conversationId: "conv-1",
          actorId: "scout",
          originNodeId: "node-1",
          class: "status",
          body: "Agent One is still working; Scout stopped waiting for a synchronous result after 300000ms.",
          replyToMessageId: "msg-1",
          visibility: "private",
          policy: "durable",
          createdAt: 150,
          metadata: {
            source: "broker",
            invocationId: "inv-1",
            flightId: "flight-1",
          },
        },
      },
      invocations: {
        "inv-1": {
          id: "inv-1",
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "agent-1",
          action: "execute",
          task: "review this",
          conversationId: "conv-1",
          messageId: "msg-1",
          ensureAwake: true,
          stream: false,
          createdAt: 110,
        },
      },
      flights: {
        "flight-1": {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "waiting",
          summary: "Agent One is still working; Scout stopped waiting for a synchronous result after 300000ms.",
          startedAt: 120,
          metadata: {
            requesterTimedOut: true,
            timeoutScope: "requester_wait",
          },
        },
      },
    });
    const service = createReadOnlyBrokerCoreService(snapshot);

    const messages = await service.readMessages?.({ conversationId: "conv-1", limit: 10 });
    const feed = await service.readAgentBrokerFeed?.({ agentId: "agent-1", limit: 10 });

    expect(messages?.map((message) => message.id)).toEqual(["msg-1"]);
    expect(feed?.items).toContainEqual(expect.objectContaining({
      kind: "flight",
      severity: "warning",
      flightId: "flight-1",
    }));
    expect(feed?.items).not.toContainEqual(expect.objectContaining({
      messageId: "msg-timeout",
    }));
    expect(feed?.counts.errors).toBe(0);
    expect(feed?.counts.warnings).toBeGreaterThanOrEqual(1);
  });

  test("splits top-level agent counts from raw registration records", async () => {
    const makeAgent = (
      id: string,
      input: {
        homeNodeId?: string;
        authorityNodeId?: string;
        metadata?: Record<string, unknown>;
      } = {},
    ) => ({
      id,
      kind: "agent" as const,
      displayName: id,
      definitionId: id.split(".")[0] ?? id,
      agentClass: "general" as const,
      capabilities: ["chat" as const],
      wakePolicy: "on_demand" as const,
      homeNodeId: input.homeNodeId ?? "node-1",
      authorityNodeId: input.authorityNodeId ?? input.homeNodeId ?? "node-1",
      advertiseScope: "local" as const,
      metadata: input.metadata,
    });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "configured.main.node-1": makeAgent("configured.main.node-1", {
          metadata: { source: "relay-agent-registry" },
        }),
        "persistent-card.main.node-1": makeAgent("persistent-card.main.node-1", {
          metadata: {
            source: "relay-agent-registry",
            cardLifecycle: { kind: "persistent" },
          },
        }),
        "reply-card.main.node-1": makeAgent("reply-card.main.node-1", {
          metadata: {
            source: "relay-agent-registry",
            cardLifecycle: { kind: "one_time" },
          },
        }),
        "managed.main.node-1": makeAgent("managed.main.node-1", {
          metadata: { source: "scout-managed", externalSource: "card_create" },
        }),
        "pairing-session.main.node-1": makeAgent("pairing-session.main.node-1", {
          metadata: { source: "scout-managed", externalSource: "pairing-session" },
        }),
        "remote.main.node-2": makeAgent("remote.main.node-2", {
          homeNodeId: "node-2",
          authorityNodeId: "node-2",
          metadata: { source: "relay-agent-registry" },
        }),
        "stale.main.node-1": makeAgent("stale.main.node-1", {
          metadata: {
            source: "relay-agent-registry",
            staleLocalRegistration: true,
            replacedByAgentId: "configured.main.node-1",
          },
        }),
        "retired.main.node-1": makeAgent("retired.main.node-1", {
          metadata: { source: "relay-agent-registry", retiredFromFleet: true },
        }),
      },
    });

    const health = await createReadOnlyBrokerCoreService(snapshot).readHealth();

    expect(health.counts).toMatchObject({
      agents: 3,
      configuredAgents: 2,
      scoutManagedAgents: 1,
      currentAgentRegistrations: 6,
      localAgentRegistrations: 5,
      remoteAgentRegistrations: 1,
      staleAgentRegistrations: 1,
      retiredAgentRegistrations: 1,
      oneTimeAgentCards: 1,
      persistentAgentCards: 1,
      agentRecords: 8,
      rawAgentRecords: 8,
    });
  });

  test("builds an agent broker feed from messages, status, and broker error records", async () => {
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        "agent-1": {
          id: "agent-1",
          kind: "agent",
          definitionId: "agent-1",
          displayName: "Agent One",
          agentClass: "general",
          capabilities: ["chat", "invoke"],
          wakePolicy: "on_demand",
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          advertiseScope: "local",
        },
      },
      endpoints: {
        "endpoint-1": {
          id: "endpoint-1",
          agentId: "agent-1",
          nodeId: "node-1",
          harness: "claude",
          transport: "tmux",
          state: "offline",
          metadata: {
            lastError: "composer did not submit",
            lastFailureStage: "dispatch_stalled",
            lastFailedAt: 180,
          },
        },
      },
      conversations: {
        "conv-1": {
          id: "conv-1",
          kind: "direct",
          title: "Agent One DM",
          authorityNodeId: "node-1",
          participantIds: ["operator", "agent-1"],
          visibility: "workspace",
          shareMode: "local",
        },
      },
      messages: {
        "msg-1": {
          id: "msg-1",
          conversationId: "conv-1",
          actorId: "operator",
          originNodeId: "node-1",
          class: "agent",
          body: "please take this",
          audience: { notify: ["agent-1"] },
          visibility: "workspace",
          policy: "durable",
          createdAt: 110,
        },
      },
      invocations: {
        "inv-1": {
          id: "inv-1",
          requesterId: "operator",
          requesterNodeId: "node-1",
          targetAgentId: "agent-1",
          action: "execute",
          task: "do the work",
          conversationId: "conv-1",
          messageId: "msg-1",
          ensureAwake: true,
          stream: false,
          createdAt: 120,
        },
      },
      flights: {
        "flight-1": {
          id: "flight-1",
          invocationId: "inv-1",
          requesterId: "operator",
          targetAgentId: "agent-1",
          state: "failed",
          summary: "Dispatch stalled",
          error: "composer did not submit",
          startedAt: 130,
          completedAt: 140,
        },
      },
    });

    const service = createBrokerCoreService({
      baseUrl: "http://broker.test",
      nodeId: "node-1",
      meshId: "mesh-1",
      localNode: {
        id: "node-1",
        meshId: "mesh-1",
        name: "node-1",
        advertiseScope: "local",
        registeredAt: 1,
        lastSeenAt: 1,
      },
      runtime: {
        snapshot: () => snapshot,
      },
      projection: {
        listActivityItems: async () => [
          {
            id: "activity:status:1",
            kind: "ask_failed",
            ts: 150,
            agentId: "agent-1",
            actorId: "agent-1",
            flightId: "flight-1",
            title: "Dispatch stalled",
            summary: "composer did not submit",
            payload: { state: "failed" },
          },
        ],
      },
      journal: {
        listCollaborationRecords: () => [],
        listCollaborationEvents: () => [],
        listDeliveries: () => [
          {
            id: "delivery-1",
            messageId: "msg-1",
            invocationId: "inv-1",
            targetId: "agent-1",
            targetKind: "agent",
            transport: "tmux",
            reason: "invocation",
            policy: "durable",
            status: "accepted",
          },
        ],
        listDeliveryAttempts: () => [
          {
            id: "attempt-1",
            deliveryId: "delivery-1",
            attempt: 1,
            status: "failed",
            error: "tmux pane was stale",
            createdAt: 155,
          },
        ],
        listScoutDispatches: () => [
          {
            id: "dispatch-1",
            kind: "unavailable",
            askedLabel: "@agent-1",
            detail: "No online endpoint",
            candidates: [],
            target: {
              agentId: "agent-1",
              displayName: "Agent One",
              reason: "manual_wake_required",
              detail: "Manual wake required",
              endpointState: "offline",
              transport: "tmux",
            },
            dispatchedAt: 170,
            dispatcherNodeId: "node-1",
            requesterId: "operator",
            conversationId: "conv-1",
            invocationId: "inv-1",
          },
        ],
      },
      threadEvents: {
        replay: async () => [],
        snapshot: async () => ({
          conversation: snapshot.conversations["conv-1"]!,
          latestSeq: 0,
          messages: [],
          collaboration: [],
          activeFlights: [],
        }),
        openWatch: async (request) => ({
          watchId: `${request.watcherId}-watch`,
          conversationId: request.conversationId,
          authorityNodeId: "node-1",
          acceptedAfterSeq: request.afterSeq ?? 0,
          latestSeq: 0,
          leaseExpiresAt: 999,
          mode: "snapshot_then_stream",
        }),
        renewWatch: async (request) => ({
          watchId: request.watchId,
          leaseExpiresAt: 999,
        }),
        closeWatch: async () => {},
      },
      isReconciledStaleFlightActivityItem: () => false,
      executeCommand: async () => ({ ok: true }),
    });

    const feed = await service.readAgentBrokerFeed?.({
      agentId: "agent-1",
      limit: 20,
    });

    expect(feed?.status).toMatchObject({
      agentId: "agent-1",
      displayName: "Agent One",
      found: true,
      lastError: "No online endpoint",
    });
    expect(feed?.status.pendingDeliveryIds).toEqual(["delivery-1"]);
    expect(feed?.counts.errors).toBeGreaterThanOrEqual(2);
    expect(feed?.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["message", "invocation", "flight", "delivery", "delivery_attempt", "dispatch"]),
    );
    expect(feed?.items.find((item) => item.kind === "flight")).toMatchObject({
      severity: "error",
      summary: "composer did not submit",
    });
  });
});
