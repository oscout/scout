import { describe, expect, test } from "bun:test";

import {
  buildScoutReturnAddress,
  type AgentDefinition,
  type AgentEndpoint,
  type ConversationDefinition,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type ScoutDeliverRequest,
  type ScoutDispatchEnvelope,
  type ScoutDispatchRecord,
} from "@openscout/protocol";

import { BrokerDeliveryAcceptanceService } from "./broker-delivery-acceptance-service.js";
import type { InvocationResolution } from "./broker-delivery-routing.js";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";

function testAgent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    labels: ["agent"],
    metadata: {},
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
    ...input,
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "tmux",
    state: "idle",
    sessionId: "session-1",
    metadata: {},
    ...input,
  };
}

function testConversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "please investigate",
    audience: { notify: ["agent-1"], reason: "direct_message" },
    visibility: "workspace",
    policy: "durable",
    createdAt: 20_000,
    metadata: {},
    ...input,
  };
}

function testSnapshot(input: {
  agents?: Record<string, AgentDefinition>;
  endpoints?: Record<string, AgentEndpoint>;
  conversations?: Record<string, ConversationDefinition>;
  messages?: Record<string, MessageRecord>;
} = {}): RuntimeSnapshot {
  return {
    nodes: {},
    actors: {},
    agents: input.agents ?? {},
    endpoints: input.endpoints ?? {},
    conversations: input.conversations ?? {},
    bindings: {},
    messages: input.messages ?? {},
    readCursors: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
  };
}

function createHarness(input: {
  resolution?: InvocationResolution;
  conversation?: ConversationDefinition;
  conversationForRequest?: (
    request: { requesterId: string; targetAgentId?: string; channel?: string },
  ) => ConversationDefinition;
  snapshot?: RuntimeSnapshot;
  isOperatorTarget?: (payload: ScoutDeliverRequest) => boolean;
  isScoutTarget?: (payload: ScoutDeliverRequest) => boolean;
  cardlessEndpointHarness?: AgentEndpoint["harness"];
  now?: number;
} = {}) {
  const agent = testAgent();
  const endpoint = testEndpoint();
  const conversation = input.conversation ?? testConversation();
  const snapshot = input.snapshot ?? testSnapshot({
    agents: { [agent.id]: agent },
    endpoints: { [endpoint.id]: endpoint },
    conversations: { [conversation.id]: conversation },
  });
  const ensuredActors: string[] = [];
  const conversationsRequested: Array<{ requesterId: string; targetAgentId?: string; channel?: string }> = [];
  const postedMessages: MessageRecord[] = [];
  const acceptedInvocations: InvocationRequest[] = [];
  const dispatchedInvocations: InvocationRequest[] = [];
  const cardlessProjectSessionCalls: Array<{
    projectPath: string;
    execution?: InvocationRequest["execution"];
    projectAgent?: ScoutDeliverRequest["projectAgent"];
    requesterId: string;
    createdAt: number;
  }> = [];
  const recordedDispatches: Array<{ envelope: ScoutDispatchEnvelope; requesterId?: string }> = [];
  const recordedWorkItemPayloads: ScoutDeliverRequest[] = [];
  const operatorIssues: Array<{
    kind: "unassigned_scout" | "rejected" | "unavailable";
    requestId: string;
    requesterId: string;
    requesterNodeId: string;
    targetLabel: string;
    detail: string;
  }> = [];
  const operatorSignals: Array<{
    signal: NonNullable<ScoutDeliverRequest["operatorSignal"]>;
    messageId: string;
    conversationId: string;
    requesterId: string;
    requesterNodeId: string;
  }> = [];
  let idCounter = 0;

  const service = new BrokerDeliveryAcceptanceService({
    nodeId: "node-1",
    operatorActorId: "operator",
    runtimeSnapshot: () => snapshot,
    createId: (prefix) => `${prefix}-${++idCounter}`,
    syncRegisteredLocalAgentsIfChanged: async () => {},
    metadataStringValue: (metadata, key) => {
      const value = metadata?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    },
    messageRefCandidateForRouteTarget: () => null,
    resolveBrokerMessageRef: () => null,
    async ensureBrokerActorForDelivery(actorId) {
      ensuredActors.push(actorId);
    },
    async ensureBrokerDeliveryConversation(request) {
      conversationsRequested.push(request);
      return input.conversationForRequest?.(request) ?? conversation;
    },
    brokerRouteKind: (conversationInput) => conversationInput.kind === "direct" ? "dm" : "channel",
    messageVisibilityForConversation: (conversationInput) => conversationInput?.visibility ?? "workspace",
    brokerActorDisplayName: (_snapshot, actorId) => actorId === agent.id ? agent.displayName : actorId,
    brokerTargetLabel: (agentInput) => agentInput.selector ?? agentInput.handle ?? agentInput.id,
    homeEndpointForAgent: (snapshotInput, agentId) =>
      Object.values(snapshotInput.endpoints).find((candidate) => candidate.agentId === agentId) ?? null,
    titleCaseName: (value) => value.slice(0, 1).toUpperCase() + value.slice(1),
    buildBrokerReturnAddressForActor: (_snapshot, actorId, options) => buildScoutReturnAddress({
      actorId,
      handle: actorId,
      conversationId: options?.conversationId,
      replyToMessageId: options?.replyToMessageId,
      sessionId: options?.sessionId,
    }),
    isOperatorDeliveryTarget: input.isOperatorTarget ?? (() => false),
    isLocalScoutProductTarget: input.isScoutTarget ?? (() => false),
    onlineConversationNotifyTargets: () => ["agent-1"],
    resolveBrokerDeliveryTargetWithImplicitProjectAgent: async () =>
      input.resolution ?? { kind: "resolved", agent },
    async createCardlessProjectSession(request) {
      cardlessProjectSessionCalls.push(request);
      const cardlessEndpoint = testEndpoint({
        id: "endpoint-cardless",
        agentId: "cardless-agent",
        sessionId: "session-cardless",
        harness: input.cardlessEndpointHarness ?? "codex",
      });
      return {
        kind: "resolved_session",
        session: {
          sessionId: "session-cardless",
          actorId: "cardless-agent",
          endpoint: cardlessEndpoint,
          label: "Cardless Session",
          nodeId: "node-1",
        },
      };
    },
    async recordScoutDispatch(envelope, options) {
      recordedDispatches.push({ envelope, requesterId: options?.requesterId });
      const record: ScoutDispatchRecord = {
        id: `dispatch-${recordedDispatches.length}`,
        requesterId: options?.requesterId,
        ...envelope,
      };
      return { record };
    },
    describeUnavailableDeliveryTarget: () => null,
    buildUnavailableDispatchEnvelope: () => {
      throw new Error("unexpected unavailable dispatch");
    },
    recordDeliveryWorkItemIfNeeded: async ({ payload }) => {
      recordedWorkItemPayloads.push(payload);
      return { record: null };
    },
    deliveryWorkItemResolutionForTell: () => ({ record: null }),
    async postConversationMessage(message) {
      postedMessages.push(message);
      return { ok: true };
    },
    async acceptInvocation(invocation) {
      acceptedInvocations.push(invocation);
      const flight: FlightRecord = {
        id: "flight-1",
        invocationId: invocation.id,
        requesterId: invocation.requesterId,
        targetAgentId: invocation.targetAgentId,
        state: "waking",
        startedAt: input.now ?? 10_000,
      };
      return flight;
    },
    async dispatchAcceptedInvocation(invocation) {
      dispatchedInvocations.push(invocation);
    },
    queueOperatorDeliveryIssue: (issue) => operatorIssues.push(issue),
    queueOperatorSignal: (signal) => operatorSignals.push(signal),
    now: () => input.now ?? 10_000,
  });

  return {
    acceptedInvocations,
    cardlessProjectSessionCalls,
    conversationsRequested,
    dispatchedInvocations,
    ensuredActors,
    operatorIssues,
    operatorSignals,
    postedMessages,
    recordedDispatches,
    recordedWorkItemPayloads,
    service,
  };
}

describe("BrokerDeliveryAcceptanceService", () => {
  test("marks an unassigned product-Scout request as reply-required and origin-correlated", async () => {
    const harness = createHarness({
      isScoutTarget: () => true,
    });

    const result = await harness.service.accept({
      id: "deliver-scout",
      body: "Create the work item",
      intent: "consult",
      targetAgentId: "scout.dispatcher",
      caller: {
        actorId: "remote-agent",
        nodeId: "remote-node",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "rejected",
      accepted: false,
      reason: "unknown_target",
    }));
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        requestId: "deliver-scout",
        replyExpectation: "required",
        routingState: "failed",
      }),
    }));
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({
        kind: "unassigned_scout",
        originConversationId: harness.postedMessages[0]!.conversationId,
        originMessageId: harness.postedMessages[0]!.id,
      }),
    ]);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.recordedDispatches).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          kind: "unknown",
          askedLabel: "scout.dispatcher",
        }),
      }),
    ]);
  });

  test("accepts an unassigned product-Scout tell without marking it failed", async () => {
    const harness = createHarness({
      isScoutTarget: () => true,
    });

    const result = await harness.service.accept({
      id: "deliver-scout-tell",
      body: "local broker status",
      intent: "tell",
      targetAgentId: "scout.dispatcher",
      caller: {
        actorId: "remote-agent",
        nodeId: "remote-node",
      },
    });

    // Fire-and-forget: nobody is blocked on a reply, so the message is simply
    // durable in the Scout thread until an operator session reads it.
    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]!.metadata).toEqual(expect.objectContaining({
      requestId: "deliver-scout-tell",
    }));
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("replyExpectation");
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("routingState");
    expect(harness.postedMessages[0]!.metadata).not.toHaveProperty("dispatchId");
    // No dispatch record and no in-thread failure mirror for an accepted send.
    expect(harness.recordedDispatches).toEqual([]);
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({ kind: "unassigned_scout" }),
    ]);
    expect(harness.operatorIssues[0]).not.toHaveProperty("originConversationId");
    expect(harness.acceptedInvocations).toEqual([]);
  });

  test("records an operator signal without creating an invocation", async () => {
    const conversation = testConversation({
      id: "dm.agent.operator",
      participantIds: ["agent-1", "operator"],
    });
    const harness = createHarness({
      conversation,
      isOperatorTarget: () => true,
      now: 11_000,
    });

    const result = await harness.service.accept({
      id: "deliver-signal",
      body: "I found the root cause and am continuing with the fix.",
      intent: "tell",
      targetLabel: "@operator",
      caller: { actorId: "agent-1", nodeId: "node-1" },
      operatorSignal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "dm.agent.operator",
      actorId: "agent-1",
      body: "I found the root cause and am continuing with the fix.",
      metadata: expect.objectContaining({
        operatorSignal: {
          kind: "notify",
          blocking: false,
          replyExpectation: "none",
        },
        operatorSignalId: "msg-1",
      }),
    }));
    expect(harness.operatorSignals).toEqual([{
      signal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
      messageId: "msg-1",
      conversationId: "dm.agent.operator",
      requesterId: "agent-1",
      requesterNodeId: "node-1",
    }]);
  });

  test("rejects malformed or lifecycle-bearing operator signals before writing", async () => {
    const harness = createHarness({ isOperatorTarget: () => true });
    const base = {
      body: "Optional input requested.",
      intent: "tell" as const,
      targetLabel: "@operator",
      caller: { actorId: "agent-1", nodeId: "node-1" },
    };

    await expect(harness.service.accept({
      ...base,
      operatorSignal: {
        kind: "consult",
        blocking: false,
        replyExpectation: "optional",
        defaultAction: " ",
      },
    })).rejects.toThrow();

    await expect(harness.service.accept({
      ...base,
      ensureAwake: false,
      operatorSignal: {
        kind: "notify",
        blocking: false,
        replyExpectation: "none",
      },
    })).rejects.toThrow("cannot carry work or invocation lifecycle fields");

    expect(harness.postedMessages).toEqual([]);
    expect(harness.operatorSignals).toEqual([]);
  });

  test("routes channel tells without creating an invocation", async () => {
    const conversation = testConversation({
      id: "channel.shared",
      kind: "channel",
      title: "Shared",
      participantIds: ["operator", "agent-1"],
    });
    const harness = createHarness({ conversation, now: 12_000 });

    const result = await harness.service.accept({
      id: "deliver-1",
      body: "hello channel",
      intent: "tell",
      target: { kind: "channel", channel: "shared" },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.routeKind).toBe("channel");
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "channel.shared",
      body: "hello channel",
      audience: expect.objectContaining({
        notify: ["agent-1"],
        reason: "conversation_visibility",
      }),
      metadata: expect.objectContaining({
        relayChannel: "shared",
        relayMessageId: "msg-1",
      }),
    }));
  });

  test("resolved consult posts a message and dispatches an invocation", async () => {
    const harness = createHarness({ now: 20_000 });

    const result = await harness.service.accept({
      id: "deliver-2",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { source: "test" },
      labels: ["urgent", "urgent"],
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.receipt).toEqual(expect.objectContaining({
      requestId: "deliver-2",
      targetAgentId: "agent-1",
      targetLabel: "@agent-one",
      conversationId: "conversation-1",
      messageId: "msg-1",
      flightId: "flight-1",
    }));
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: "msg-1",
      actorId: "operator",
      body: "please investigate",
      mentions: [{ actorId: "agent-1", label: "@agent-one" }],
      metadata: expect.objectContaining({
        labels: ["urgent"],
        relayTarget: "agent-1",
        relayMessageId: "msg-1",
      }),
    }));
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      id: "inv-2",
      action: "consult",
      targetAgentId: "agent-1",
      task: "please investigate",
      conversationId: "conversation-1",
      messageId: "msg-1",
      metadata: expect.objectContaining({
        source: "test",
        labels: ["urgent"],
        relayTarget: "agent-1",
      }),
    }));
    expect(harness.dispatchedInvocations).toEqual(harness.acceptedInvocations);
  });

  test("replays a committed delivery by stable client and request ids without a second write", async () => {
    const message = testMessage({
      metadata: {
        clientMessageId: "ios-stable-1",
        deliveryRequestId: "deliver-client-stable-1",
        relayTarget: "agent-1",
      },
    });
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        endpoints: { "endpoint-1": testEndpoint() },
        conversations: { "conversation-1": testConversation() },
        messages: { [message.id]: message },
      }),
    });

    const result = await harness.service.accept({
      id: "deliver-client-stable-1",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { clientMessageId: "ios-stable-1" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      message: expect.objectContaining({ id: message.id }),
      receipt: expect.objectContaining({
        requestId: "deliver-client-stable-1",
        messageId: message.id,
      }),
    }));
    expect(harness.postedMessages).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
    expect(harness.dispatchedInvocations).toEqual([]);
  });

  test("promotes a recoverable durable message instead of creating a duplicate bubble", async () => {
    const message = testMessage({
      id: "message-recoverable",
      metadata: { clientMessageId: "ios-recoverable-1" },
    });
    const harness = createHarness({
      snapshot: testSnapshot({
        agents: { "agent-1": testAgent() },
        endpoints: { "endpoint-1": testEndpoint() },
        conversations: { "conversation-1": testConversation() },
        messages: { [message.id]: message },
      }),
    });

    const result = await harness.service.accept({
      id: "deliver-client-recoverable-1",
      body: "please investigate",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { clientMessageId: "ios-recoverable-1" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      message: expect.objectContaining({ id: message.id }),
    }));
    expect(harness.postedMessages).toHaveLength(1);
    expect(harness.postedMessages[0]).toEqual(expect.objectContaining({
      id: message.id,
      metadata: expect.objectContaining({
        clientMessageId: "ios-recoverable-1",
        deliveryRequestId: "deliver-client-recoverable-1",
      }),
    }));
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]?.messageId).toBe(message.id);
  });

  test("resolved target handles continue the resolved session", async () => {
    const sessionEndpoint = testEndpoint({
      id: "endpoint-session",
      agentId: "session-agent",
      sessionId: "session-mw-talkie",
    });
    const harness = createHarness({
      now: 20_250,
      resolution: {
        kind: "resolved_session",
        session: {
          sessionId: "session-mw-talkie",
          actorId: "session-agent",
          endpoint: sessionEndpoint,
          label: "target:mw-talkie",
          nodeId: "node-1",
        },
      },
    });

    const result = await harness.service.accept({
      id: "deliver-target-handle",
      body: "continue the editorial pass",
      intent: "consult",
      target: { kind: "target_handle", handle: "mw-talkie", value: "target:mw-talkie" },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(result).toEqual(expect.objectContaining({
      targetAgentId: "session-agent",
      targetSessionId: "session-mw-talkie",
    }));
    expect(harness.postedMessages[0]?.metadata).toEqual(expect.objectContaining({
      targetSessionId: "session-mw-talkie",
    }));
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: "session-agent",
      execution: expect.objectContaining({
        session: "existing",
        targetSessionId: "session-mw-talkie",
      }),
      metadata: expect.objectContaining({
        targetSessionId: "session-mw-talkie",
      }),
    }));
  });

  test("project-path consult with an explicit agent target does not synthesize a cardless session", async () => {
    const harness = createHarness({ now: 20_500 });

    const result = await harness.service.accept({
      id: "deliver-project-agent",
      body: "start from this project context",
      intent: "consult",
      target: { kind: "project_path", projectPath: "/tmp/openscout" },
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { session: "new", harness: "codex" },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.cardlessProjectSessionCalls).toEqual([]);
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: "agent-1",
      execution: { session: "new", harness: "codex" },
      task: "start from this project context",
    }));
  });

  test("runtime-profile consult starts a cardless current-project session with broker-owned execution", async () => {
    const harness = createHarness({
      now: 20_750,
      cardlessEndpointHarness: "claude",
    });

    const result = await harness.service.accept({
      id: "deliver-profile-opus",
      body: "review the parser",
      intent: "consult",
      target: {
        kind: "runtime_profile",
        profile: "opus",
        projectPath: "/tmp/openscout",
        reasoningEffort: "high",
      },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.cardlessProjectSessionCalls).toEqual([{
      projectPath: "/tmp/openscout",
      execution: {
        harness: "claude",
        model: "claude-opus-5",
        reasoningEffort: "high",
        session: "new",
      },
      projectAgent: undefined,
      requesterId: "operator",
      createdAt: 20_750,
    }]);
    expect(harness.acceptedInvocations[0]?.execution).toEqual({
      harness: "claude",
      model: "claude-opus-5",
      reasoningEffort: "high",
      session: "existing",
      targetSessionId: "session-cardless",
    });
    expect(harness.acceptedInvocations[0]?.executionResolution).toEqual(expect.objectContaining({
      schemaVersion: "openscout.execution-resolution.v1",
      harness: expect.objectContaining({ resolved: "claude", source: "profile", drift: "unknown" }),
      model: expect.objectContaining({ resolved: "claude-opus-5", source: "profile", drift: "unknown" }),
      reasoningEffort: expect.objectContaining({ resolved: "high", source: "profile", drift: "unknown" }),
    }));
  });

  test("normalizes exact models, preserves literal provenance, and rejects unsupported dimensions", async () => {
    const harness = createHarness({ now: 20_800 });
    const result = await harness.service.accept({
      id: "deliver-exact-runtime",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "codex", model: "5.6", reasoningEffort: "xhigh" },
      executionSource: { harness: "literal", model: "literal", reasoningEffort: "literal" },
    });
    expect(harness.acceptedInvocations[0]?.execution).toEqual(expect.objectContaining({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    }));
    expect(harness.acceptedInvocations[0]?.executionResolution?.model).toEqual(expect.objectContaining({
      requested: "5.6",
      resolved: "gpt-5.6-sol",
      source: "literal",
    }));
    expect(result.kind === "delivery" ? result.receipt.executionResolution?.model : undefined)
      .toEqual(expect.objectContaining({
        requested: "5.6",
        resolved: "gpt-5.6-sol",
        source: "literal",
      }));

    await expect(harness.service.accept({
      id: "deliver-unsupported-model",
      body: "review",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: { harness: "kimi", model: "some-model" },
    })).rejects.toThrow("unsupported_model_dimension");
  });

  test("invalid runtime profiles fail closed before cardless session creation", async () => {
    const harness = createHarness({
      now: 20_875,
      resolution: {
        kind: "unknown",
        label: "profile:composer-review",
        detail: 'unknown runtime profile "composer-review"',
      },
    });

    const result = await harness.service.accept({
      id: "deliver-profile-unknown",
      body: "review the parser",
      intent: "consult",
      target: {
        kind: "runtime_profile",
        profile: "composer-review",
        projectPath: "/tmp/openscout",
      },
      caller: { actorId: "operator", nodeId: "node-1" },
    });

    expect(result.kind).toBe("rejected");
    expect(harness.cardlessProjectSessionCalls).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
  });

  test("runtime profiles with unsupported effort fail closed before cardless session creation", async () => {
    for (const profile of ["kimi", "grok"]) {
      const harness = createHarness({
        now: 20_900,
        resolution: {
          kind: "unparseable",
          label: `profile:${profile}`,
        },
      });

      const result = await harness.service.accept({
        id: `deliver-profile-${profile}-effort`,
        body: "review the parser",
        intent: "consult",
        target: {
          kind: "runtime_profile",
          profile,
          projectPath: "/tmp/openscout",
          reasoningEffort: "high",
        },
        caller: { actorId: "operator", nodeId: "node-1" },
      });

      expect(result.kind).toBe("rejected");
      expect(harness.cardlessProjectSessionCalls).toEqual([]);
      expect(harness.acceptedInvocations).toEqual([]);
    }
  });

  test("preserves requested fork execution when accepting a consult", async () => {
    const harness = createHarness({ now: 21_000 });

    const result = await harness.service.accept({
      id: "deliver-fork",
      body: "continue from the prior run",
      intent: "consult",
      targetAgentId: "agent-1",
      caller: { actorId: "operator", nodeId: "node-1" },
      execution: {
        harness: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        session: "fork",
        forkFromSessionId: "session-source-1",
      },
    });

    expect(result.kind).toBe("delivery");
    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]?.execution).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      session: "fork",
      forkFromSessionId: "session-source-1",
    });
  });

  test("channel consult posts a canonical channel message and broker pointer DM", async () => {
    const channelConversation = testConversation({
      id: "channel.xterm-super-component",
      kind: "channel",
      title: "xterm-super-component",
      visibility: "workspace",
      participantIds: ["operator", "agent-1"],
    });
    const directConversation = testConversation({
      id: "dm.operator.agent-1",
      kind: "direct",
      title: "Agent One",
      visibility: "private",
      participantIds: ["operator", "agent-1"],
    });
    const harness = createHarness({
      conversation: channelConversation,
      conversationForRequest: (request) => request.channel ? channelConversation : directConversation,
      now: 40_000,
    });

    const result = await harness.service.accept({
      id: "deliver-channel-1",
      body: "@agent-one please take pass 2",
      intent: "consult",
      targetAgentId: "agent-1",
      channel: "xterm-super-component",
      caller: { actorId: "operator", nodeId: "node-1" },
      messageMetadata: { source: "test" },
      invocationMetadata: { source: "test" },
    });

    expect(result.kind).toBe("delivery");
    expect(result.accepted).toBe(true);
    expect(result.conversation.id).toBe("channel.xterm-super-component");
    expect(harness.conversationsRequested).toEqual([
      { requesterId: "operator", targetAgentId: "agent-1", channel: "xterm-super-component" },
      { requesterId: "operator", targetAgentId: "agent-1" },
    ]);
    expect(harness.postedMessages).toHaveLength(2);

    const [canonical, pointer] = harness.postedMessages;
    expect(canonical).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "channel.xterm-super-component",
      body: "@agent-one please take pass 2",
      audience: expect.objectContaining({
        notify: ["agent-1"],
        reason: "mention",
      }),
      metadata: expect.objectContaining({
        relayChannel: "xterm-super-component",
        relayTarget: "agent-1",
        relayMessageId: "msg-1",
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));

    expect(pointer).toEqual(expect.objectContaining({
      id: "msg-2",
      conversationId: "dm.operator.agent-1",
      actorId: "operator",
      class: "status",
      mentions: [{ actorId: "agent-1", label: "@agent-one" }],
      audience: {
        notify: ["agent-1"],
        reason: "direct_message",
      },
      metadata: expect.objectContaining({
        source: "broker-channel-attention",
        brokerGenerated: true,
        attentionKind: "channel_pointer",
        relayChannel: "dm",
        relayTarget: "agent-1",
        relayTargetIds: ["agent-1"],
        relayMessageId: "msg-2",
        channelPointer: expect.objectContaining({
          channel: "xterm-super-component",
          conversationId: "channel.xterm-super-component",
          messageId: "msg-1",
          intent: "consult",
          targetAgentId: "agent-1",
        }),
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));
    expect(pointer!.body).toContain("Reply in #xterm-super-component.");
    expect(pointer!.body).not.toContain("please take pass 2");

    expect(harness.acceptedInvocations).toHaveLength(1);
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      conversationId: "channel.xterm-super-component",
      messageId: "msg-1",
      task: "@agent-one please take pass 2",
      metadata: expect.objectContaining({
        relayChannel: "xterm-super-component",
        relayTarget: "agent-1",
        returnAddress: expect.objectContaining({
          conversationId: "channel.xterm-super-component",
          replyToMessageId: "msg-1",
        }),
      }),
    }));
  });

  test("unresolved targets record a dispatch and operator issue", async () => {
    const harness = createHarness({
      resolution: { kind: "unknown", label: "@missing" },
      now: 30_000,
    });

    const result = await harness.service.accept({
      id: "deliver-3",
      body: "hello?",
      intent: "consult",
      targetLabel: "@missing",
      caller: { actorId: "remote-agent", nodeId: "node-remote" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "rejected",
      accepted: false,
      reason: "unknown_target",
      rejection: expect.objectContaining({
        id: "dispatch-1",
        kind: "unknown",
        askedLabel: "@missing",
        requesterId: "remote-agent",
      }),
    }));
    expect(harness.recordedDispatches).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          kind: "unknown",
          askedLabel: "@missing",
        }),
        requesterId: "remote-agent",
      }),
    ]);
    expect(harness.operatorIssues).toEqual([
      expect.objectContaining({
        kind: "rejected",
        requestId: "deliver-3",
        requesterId: "remote-agent",
        requesterNodeId: "node-remote",
        targetLabel: "@missing",
      }),
    ]);
    expect(harness.postedMessages).toEqual([]);
    expect(harness.acceptedInvocations).toEqual([]);
  });

  test("pins alias proof and exact-session semantics across receipt, message, and invocation", async () => {
    const agent = testAgent();
    const endpoint = testEndpoint();
    const aliasResolution = {
      bindingId: "alias-1",
      revision: 4,
      requestedAlias: "patch",
      scope: { projectKey: "project:alpha", projectRoot: "/work/alpha", nodeId: "node-1" },
      target: {
        kind: "session" as const,
        sessionId: "session-1",
        agentId: agent.id,
        endpointId: endpoint.id,
        nodeId: endpoint.nodeId,
        harness: endpoint.harness,
      },
      resolvedAt: 40_000,
    };
    const harness = createHarness({
      resolution: { kind: "resolved", agent, aliasResolution },
      now: 40_000,
    });

    const result = await harness.service.accept({
      id: "deliver-alias",
      body: "continue exactly here",
      intent: "consult",
      target: { kind: "route_alias", alias: "patch" },
      caller: { actorId: "operator", nodeId: "node-1", currentDirectory: "/work/alpha" },
      workItem: { title: "Continue patch" },
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "delivery",
      accepted: true,
      targetAgentId: agent.id,
      targetSessionId: "session-1",
      aliasResolution,
      receipt: expect.objectContaining({
        targetAgentId: agent.id,
        targetSessionId: "session-1",
        aliasResolution,
      }),
    }));
    expect(harness.postedMessages[0]?.metadata).toEqual(expect.objectContaining({ aliasResolution }));
    expect(harness.acceptedInvocations[0]).toEqual(expect.objectContaining({
      targetAgentId: agent.id,
      execution: expect.objectContaining({ session: "existing", targetSessionId: "session-1" }),
      metadata: expect.objectContaining({ aliasResolution }),
    }));
    expect(harness.recordedWorkItemPayloads[0]?.workItem?.metadata).toEqual(
      expect.objectContaining({ aliasResolution }),
    );
  });
});
