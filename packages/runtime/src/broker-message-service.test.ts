import { describe, expect, test } from "bun:test";

import {
  type AgentDefinition,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  BrokerMessageService,
  type BrokerMessageMesh,
} from "./broker-message-service.js";

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
    capabilities: ["chat", "invoke"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "mesh-1",
    name: "Peer",
    advertiseScope: "mesh",
    registeredAt: 100,
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-local",
    participantIds: ["operator", "agent-1"],
    metadata: {},
    ...input,
  };
}

function message(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    conversationId: "conversation-1",
    actorId: "agent-1",
    originNodeId: "node-local",
    class: "agent",
    body: "done",
    replyToMessageId: "msg-parent",
    visibility: "workspace",
    policy: "durable",
    createdAt: 120,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-local",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-parent",
    createdAt: 100,
    ...input,
  };
}

function flight(input: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "flight-1",
    invocationId: "invocation-1",
    requesterId: "operator",
    targetAgentId: "agent-1",
    state: "running",
    startedAt: 110,
    metadata: { dispatch: "ok" },
    ...input,
  };
}

function delivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "msg-1",
    targetId: "agent-1",
    targetNodeId: "node-local",
    targetKind: "agent",
    transport: "local_socket",
    reason: "notify",
    policy: "durable",
    status: "pending",
    ...input,
  };
}

function createHarness(input: {
  agents?: Record<string, AgentDefinition>;
  conversations?: Record<string, ConversationDefinition>;
  invocations?: Record<string, InvocationRequest>;
  messages?: Record<string, MessageRecord>;
  flights?: Record<string, FlightRecord>;
  mesh?: Partial<BrokerMessageMesh>;
  activeLocalEndpointForAgent?: (agentId: string) => unknown;
} = {}) {
  const agents = input.agents ?? { "agent-1": agent() };
  const conversations = input.conversations ?? { "conversation-1": conversation() };
  const invocations = input.invocations ?? {};
  const messages = input.messages ?? {};
  const flights = input.flights ?? {};
  const recordedMessages: Array<{
    message: MessageRecord;
    options?: { enqueueProjection?: boolean };
  }> = [];
  const projectedEntries: BrokerJournalEntry[][] = [];
  const forwardedPeerDeliveries: Array<{
    message: MessageRecord;
    deliveries: DeliveryIntent[];
  }> = [];
  const persistedFlights: FlightRecord[] = [];
  let reconcileCount = 0;
  let nextId = 0;

  const mesh: BrokerMessageMesh = {
    authorityNodeForConversation: () => null,
    async forwardConversationMessageToAuthority() {
      return { forwarded: true, authorityNodeId: "node-peer" };
    },
    async forwardPeerBrokerDeliveries(nextMessage, deliveries) {
      forwardedPeerDeliveries.push({ message: nextMessage, deliveries });
      return { forwarded: [], failed: [] };
    },
    ...input.mesh,
  };

  const service = new BrokerMessageService({
    nodeId: "node-local",
    systemActorId: "system",
    runtime: {
      peek: () => ({ messages }),
      snapshot: () => ({ invocations }),
      conversation: (conversationId) => conversations[conversationId],
      agent: (agentId) => agents[agentId],
      flightForInvocation: (invocationId) => flights[invocationId],
    },
    mesh,
    createId: (prefix) => `${prefix}-${++nextId}`,
    async recordMessage(nextMessage, options) {
      recordedMessages.push({ message: nextMessage, options });
      messages[nextMessage.id] = nextMessage;
      const nextDelivery = delivery({ id: `delivery-${recordedMessages.length}`, messageId: nextMessage.id });
      return {
        deliveries: [nextDelivery],
        entries: [{ kind: "message.record", message: nextMessage }],
      };
    },
    async applyProjectedEntries(entries) {
      projectedEntries.push(entries);
    },
    async reconcileStaleLocalDeliveries() {
      reconcileCount += 1;
    },
    async persistFlight(nextFlight) {
      persistedFlights.push(nextFlight);
      flights[nextFlight.invocationId] = nextFlight;
    },
    activeLocalEndpointForAgent: input.activeLocalEndpointForAgent ?? (() => ({ id: "endpoint-1" })),
  });

  return {
    agents,
    conversations,
    forwardedPeerDeliveries,
    invocations,
    messages,
    persistedFlights,
    projectedEntries,
    recordedMessages,
    reconcileCount: () => reconcileCount,
    service,
  };
}

describe("BrokerMessageService", () => {
  test("returns an idempotent client-message retry without replaying deliveries", async () => {
    const existing = message({
      id: "m-client-stable",
      actorId: "operator",
      class: "operator",
      body: "same request",
      replyToMessageId: undefined,
      metadata: { clientMessageId: "web-stable-1" },
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    const result = await harness.service.postConversationMessage({
      ...existing,
      createdAt: existing.createdAt + 5_000,
    });

    expect(result).toMatchObject({
      ok: true,
      duplicate: true,
      message: existing,
      deliveries: [],
    });
    expect(harness.recordedMessages).toHaveLength(0);
    expect(harness.forwardedPeerDeliveries).toHaveLength(0);
  });

  test("rejects reuse of a message id for different content", async () => {
    const existing = message({
      id: "m-client-stable",
      metadata: { clientMessageId: "web-stable-1" },
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    await expect(harness.service.postConversationMessage({
      ...existing,
      body: "different request",
    })).rejects.toThrow("already assigned to a different record");
  });

  test("rejects reuse of a message id with different attachments", async () => {
    const existing = message({
      id: "m-client-stable",
      metadata: { clientMessageId: "web-stable-1" },
      attachments: [{ id: "attachment-1", mediaType: "text/plain", fileName: "one.txt" }],
    });
    const harness = createHarness({ messages: { [existing.id]: existing } });

    await expect(harness.service.postConversationMessage({
      ...existing,
      attachments: [{ id: "attachment-2", mediaType: "text/plain", fileName: "two.txt" }],
    })).rejects.toThrow("already assigned to a different record");
  });

  test("posts local messages durably, projects entries, reconciles, and completes matching invocations", async () => {
    const nextInvocation = invocation();
    const nextFlight = flight();
    const harness = createHarness({
      invocations: { [nextInvocation.id]: nextInvocation },
      flights: { [nextInvocation.id]: nextFlight },
    });

    const result = await harness.service.postConversationMessage(message({
      id: "msg-reply",
      body: "All done",
      createdAt: 130,
    }));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      message: expect.objectContaining({ id: "msg-reply" }),
      deliveries: [expect.objectContaining({ id: "delivery-1", messageId: "msg-reply" })],
    }));
    expect(harness.recordedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg-reply" }),
        options: { enqueueProjection: false },
      }),
    ]);
    expect(harness.forwardedPeerDeliveries).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg-reply" }),
        deliveries: [expect.objectContaining({ id: "delivery-1" })],
      }),
    ]);
    expect(harness.projectedEntries).toEqual([
      [expect.objectContaining({ kind: "message.record" })],
    ]);
    expect(harness.reconcileCount()).toBe(1);
    expect(harness.persistedFlights).toEqual([
      expect.objectContaining({
        id: "flight-1",
        state: "completed",
        output: "All done",
        completedAt: 130,
        metadata: expect.objectContaining({
          dispatch: "ok",
          completedByBrokerReply: true,
          replyMessageId: "msg-reply",
        }),
      }),
    ]);
  });

  test("forwards remote-authority messages without local durable writes", async () => {
    const remoteDelivery = delivery({ id: "remote-delivery" });
    const authorityConversation = conversation({
      shareMode: "shared",
      authorityNodeId: "node-peer",
    });
    const harness = createHarness({
      mesh: {
        authorityNodeForConversation: () => ({
          conversation: authorityConversation,
          authorityNode: node(),
        }),
        async forwardConversationMessageToAuthority() {
          return {
            forwarded: true,
            authorityNodeId: "node-peer",
            duplicate: true,
            deliveries: [remoteDelivery],
          };
        },
      },
    });

    const result = await harness.service.postConversationMessage(message());

    expect(result).toEqual({
      ok: true,
      message: message(),
      forwarded: true,
      authorityNodeId: "node-peer",
      duplicate: true,
      deliveries: [remoteDelivery],
    });
    expect(harness.recordedMessages).toEqual([]);
    expect(harness.forwardedPeerDeliveries).toEqual([]);
    expect(harness.projectedEntries).toEqual([]);
    expect(harness.reconcileCount()).toBe(0);
    expect(harness.persistedFlights).toEqual([]);
  });

  test("posts invocation status messages only when a conversation and body exist", async () => {
    const privateConversation = conversation({ visibility: "private" });
    const harness = createHarness({
      conversations: { [privateConversation.id]: privateConversation },
    });
    const nextInvocation = invocation();

    await harness.service.postInvocationStatusMessage(nextInvocation, {
      id: "flight-1",
      summary: "Working",
      error: "Needs attention",
    });
    await harness.service.postInvocationStatusMessage(nextInvocation, {
      id: "flight-empty",
      summary: " ",
      error: "",
    });
    await harness.service.postInvocationStatusMessage(invocation({
      id: "missing-conversation",
      conversationId: "missing",
    }), {
      summary: "Ignored",
    });
    await harness.service.postInvocationStatusMessage(invocation({
      id: "no-conversation",
      conversationId: undefined,
    }), {
      summary: "Ignored",
    });

    expect(harness.recordedMessages).toHaveLength(1);
    expect(harness.recordedMessages[0]?.message).toEqual(expect.objectContaining({
      id: "msg-1",
      conversationId: "conversation-1",
      actorId: "system",
      originNodeId: "node-local",
      class: "status",
      body: "Working\nNeeds attention",
      replyToMessageId: "msg-parent",
      audience: { notify: ["operator"] },
      visibility: "private",
      policy: "durable",
      metadata: {
        flightId: "flight-1",
        invocationId: "invocation-1",
        source: "broker",
        targetAgentId: "agent-1",
      },
    }));
  });

  test("does not enqueue status notifications for inline and none invocations", async () => {
    for (const replyMode of ["inline", "none"] as const) {
      const harness = createHarness();
      await harness.service.postInvocationStatusMessage(invocation({
        metadata: { replyMode },
      }), {
        id: `flight-${replyMode}`,
        error: `${replyMode} failed`,
      });

      expect(harness.recordedMessages).toHaveLength(1);
      expect(harness.recordedMessages[0]?.message.audience).toEqual({ delivery: "none" });
    }
  });

  test("enqueues status notifications for explicit notify and legacy invocations", async () => {
    for (const metadata of [{ replyMode: "notify" }, {}]) {
      const harness = createHarness();
      await harness.service.postInvocationStatusMessage(invocation({ metadata }), {
        error: "failed",
      });

      expect(harness.recordedMessages[0]?.message.audience).toEqual({
        notify: ["operator"],
      });
    }
  });

  test("finds the newest existing broker reply using the reply lookback window", () => {
    const olderReply = message({ id: "old", createdAt: 4_999 });
    const firstReply = message({ id: "first", createdAt: 5_000 });
    const newestReply = message({ id: "newest", createdAt: 7_000 });
    const harness = createHarness({
      messages: {
        old: olderReply,
        first: firstReply,
        newest: newestReply,
        wrongActor: message({ id: "wrongActor", actorId: "agent-2", createdAt: 8_000 }),
        wrongClass: message({ id: "wrongClass", class: "status", createdAt: 9_000 }),
      },
    });

    expect(harness.service.existingBrokerReplyForInvocation(invocation(), "agent-1", 10_000))
      .toBe(newestReply);
    expect(harness.service.existingBrokerReplyForInvocation(invocation({
      conversationId: undefined,
    }), "agent-1", 10_000)).toBeNull();
    expect(harness.service.existingBrokerReplyForInvocation(invocation({
      messageId: undefined,
    }), "agent-1", 10_000)).toBeNull();
  });

  test("online conversation notify targets skip the requester, unknown agents, and offline participants", () => {
    const harness = createHarness({
      agents: {
        "agent-1": agent({ id: "agent-1" }),
        "agent-2": agent({ id: "agent-2" }),
      },
      activeLocalEndpointForAgent: (agentId) => agentId === "agent-2" ? { id: "endpoint-2" } : null,
    });

    expect(harness.service.onlineConversationNotifyTargets(conversation({
      participantIds: ["operator", "agent-1", "agent-2", "unknown"],
    }), "operator")).toEqual(["agent-2"]);
  });
});
