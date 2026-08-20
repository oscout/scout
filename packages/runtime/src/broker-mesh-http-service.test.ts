import { describe, expect, test } from "bun:test";

import {
  type ActorIdentity,
  type AgentDefinition,
  type CollaborationEvent,
  type CollaborationRecord,
  type ConversationDefinition,
  type DeliveryIntent,
  type FlightRecord,
  type InvocationRequest,
  type MessageRecord,
  type NodeDefinition,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";
import {
  BrokerMeshHttpService,
} from "./broker-mesh-http-service.js";
import type {
  MeshCollaborationEventBundle,
  MeshCollaborationRecordBundle,
  MeshInvocationBundle,
  MeshMessageBundle,
} from "./mesh-forwarding.js";

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
    capabilities: ["chat", "invoke"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function conversation(input: Partial<ConversationDefinition> = {}): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "channel",
    title: "shared",
    visibility: "workspace",
    shareMode: "shared",
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
    actorId: "operator",
    originNodeId: "node-peer",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
    ...input,
  };
}

function invocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-peer",
    targetAgentId: "agent-1",
    action: "consult",
    task: "work",
    ensureAwake: true,
    stream: false,
    conversationId: "conversation-1",
    messageId: "msg-1",
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
    state: "queued",
    startedAt: 100,
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
    reason: "conversation_visibility",
    policy: "durable",
    status: "pending",
    ...input,
  };
}

function workItem(input: Partial<CollaborationRecord> = {}): CollaborationRecord {
  return {
    id: "work-1",
    kind: "work_item",
    state: "working",
    acceptanceState: "none",
    title: "Investigate mesh",
    createdById: "operator",
    ownerId: "agent-1",
    nextMoveOwnerId: "agent-1",
    requestedById: "operator",
    conversationId: "conversation-1",
    createdAt: 100,
    updatedAt: 100,
    ...input,
  } as CollaborationRecord;
}

function collaborationEvent(input: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: "event-1",
    recordId: "work-1",
    recordKind: "work_item",
    kind: "progressed",
    actorId: "agent-1",
    at: 120,
    ...input,
  };
}

function messageBundle(input: Partial<MeshMessageBundle> = {}): MeshMessageBundle {
  const nextConversation = input.conversation ?? conversation();
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: nextConversation,
    bindings: [],
    message: message({ conversationId: nextConversation.id }),
    ...input,
  };
}

function invocationBundle(input: Partial<MeshInvocationBundle> = {}): MeshInvocationBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    invocation: invocation(),
    ...input,
  };
}

function collaborationRecordBundle(input: Partial<MeshCollaborationRecordBundle> = {}): MeshCollaborationRecordBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    record: workItem(),
    ...input,
  };
}

function collaborationEventBundle(input: Partial<MeshCollaborationEventBundle> = {}): MeshCollaborationEventBundle {
  return {
    originNode: node(),
    actors: [actor()],
    agents: [agent()],
    conversation: conversation(),
    record: workItem(),
    event: collaborationEvent(),
    ...input,
  };
}

function createHarness(input: {
  agents?: Record<string, AgentDefinition>;
  messages?: Record<string, MessageRecord>;
  flights?: Record<string, FlightRecord>;
  records?: Record<string, CollaborationRecord>;
} = {}) {
  const agents = input.agents ?? {};
  const messages = input.messages ?? {};
  const flights = input.flights ?? {};
  const records = input.records ?? {};
  const applyBundleCalls: Array<MeshMessageBundle | MeshInvocationBundle | MeshCollaborationRecordBundle | MeshCollaborationEventBundle> = [];
  const committedEntries: BrokerJournalEntry[][] = [];
  const projectedEntries: BrokerJournalEntry[][] = [];
  const rememberedInvocations: InvocationRequest[] = [];
  const runDispatchJobs: Array<{ job: BrokerInvocationDispatchJob; invocation: InvocationRequest }> = [];

  const service = new BrokerMeshHttpService({
    nodeId: "node-local",
    runtime: {
      message: (messageId) => messages[messageId],
      planMessage: (nextMessage) => [delivery({ messageId: nextMessage.id })],
      async commitMessage(nextMessage) {
        messages[nextMessage.id] = nextMessage;
      },
      agent: (agentId) => agents[agentId],
      flightForInvocation: (invocationId) => flights[invocationId],
      planInvocation: (nextInvocation) => flight({
        invocationId: nextInvocation.id,
        requesterId: nextInvocation.requesterId,
        targetAgentId: nextInvocation.targetAgentId,
      }),
      async commitInvocation(_nextInvocation, nextFlight) {
        flights[nextFlight.invocationId] = nextFlight;
      },
      collaborationRecord: (recordId) => records[recordId],
    },
    async runDurableWrite(work) {
      return await work();
    },
    async applyMeshBundle(bundle) {
      applyBundleCalls.push(bundle);
      for (const nextAgent of bundle.agents) {
        agents[nextAgent.id] = nextAgent;
      }
      if ("record" in bundle && bundle.record) {
        records[bundle.record.id] = bundle.record;
      }
      return [{ kind: "node.upsert", node: bundle.originNode }];
    },
    async commitEntries(entries, applyRuntime) {
      const normalized = Array.isArray(entries) ? entries : [entries];
      committedEntries.push(normalized);
      await applyRuntime(normalized);
      return normalized;
    },
    async applyProjectedEntries(entries) {
      projectedEntries.push(entries);
    },
    rememberInvocation(nextInvocation) {
      rememberedInvocations.push(nextInvocation);
    },
    async runDispatchJob(job, nextInvocation) {
      runDispatchJobs.push({ job, invocation: nextInvocation });
    },
  });

  return {
    agents,
    applyBundleCalls,
    committedEntries,
    flights,
    messages,
    projectedEntries,
    records,
    rememberedInvocations,
    runDispatchJobs,
    service,
  };
}

describe("BrokerMeshHttpService", () => {
  test("records local-authority mesh messages and projects bundle plus message entries", async () => {
    const harness = createHarness();
    const bundle = messageBundle();

    const result = await harness.service.receiveMessageBundle(bundle);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        deliveries: [expect.objectContaining({ id: "delivery-1", messageId: "msg-1" })],
      },
    });
    expect(harness.messages["msg-1"]).toBe(bundle.message);
    expect(harness.committedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "message.record",
      "deliveries.record",
    ]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "node.upsert",
      "message.record",
      "deliveries.record",
    ]);
  });

  test("rejects non-authority mesh messages after projecting retained bundle entries", async () => {
    const harness = createHarness();
    const bundle = messageBundle({
      conversation: conversation({ authorityNodeId: "node-peer" }),
    });

    const result = await harness.service.receiveMessageBundle(bundle);

    expect(result).toEqual({
      status: 409,
      body: {
        error: "not_authority",
        detail: "conversation conversation-1 is owned by node-peer",
      },
    });
    expect(harness.messages["msg-1"]).toBeUndefined();
    expect(harness.committedEntries).toEqual([]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });

  test("records local-authority mesh invocations and remembers them for daemon reads", async () => {
    const nextAgent = agent({ id: "agent-from-bundle" });
    const nextInvocation = invocation({
      id: "invocation-from-bundle",
      targetAgentId: nextAgent.id,
    });
    const bundle = invocationBundle({
      agents: [nextAgent],
      invocation: nextInvocation,
    });
    const harness = createHarness();

    const result = await harness.service.receiveInvocationBundle(bundle);

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        flight: expect.objectContaining({
          invocationId: "invocation-from-bundle",
          targetAgentId: "agent-from-bundle",
        }),
      },
    });
    expect(harness.rememberedInvocations).toEqual([nextInvocation]);
    expect(harness.runDispatchJobs).toEqual([
      expect.objectContaining({
        invocation: nextInvocation,
        job: expect.objectContaining({
          invocationId: "invocation-from-bundle",
          targetAgentId: "agent-from-bundle",
          state: "pending",
        }),
      }),
    ]);
    expect(harness.committedEntries[0]?.map((entry) => entry.kind)).toEqual([
      "invocation.record",
      "invocation.dispatch_job.record",
      "flight.record",
    ]);
    expect(harness.flights["invocation-from-bundle"]).toEqual(expect.objectContaining({
      invocationId: "invocation-from-bundle",
    }));
  });

  test("returns duplicate mesh invocations without appending invocation entries", async () => {
    const existing = flight();
    const harness = createHarness({
      agents: { "agent-1": agent() },
      flights: { "invocation-1": existing },
    });

    const result = await harness.service.receiveInvocationBundle(invocationBundle());

    expect(result).toEqual({
      status: 200,
      body: { ok: true, duplicate: true, flight: existing },
    });
    expect(harness.committedEntries).toEqual([]);
    expect(harness.rememberedInvocations).toEqual([]);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });

  test("rejects non-authority collaboration records without applying the bundle", async () => {
    const harness = createHarness();
    const bundle = collaborationRecordBundle({
      conversation: conversation({ authorityNodeId: "node-peer" }),
    });

    const result = await harness.service.receiveCollaborationRecordBundle(bundle);

    expect(result).toEqual({
      status: 409,
      body: {
        error: "not_authority",
        detail: "conversation conversation-1 is owned by node-peer",
      },
    });
    expect(harness.applyBundleCalls).toEqual([]);
    expect(harness.projectedEntries).toEqual([]);
  });

  test("applies local collaboration events and projects retained entries", async () => {
    const harness = createHarness();

    const result = await harness.service.receiveCollaborationEventBundle(collaborationEventBundle());

    expect(result).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(harness.applyBundleCalls).toHaveLength(1);
    expect(harness.projectedEntries[0]?.map((entry) => entry.kind)).toEqual(["node.upsert"]);
  });
});
