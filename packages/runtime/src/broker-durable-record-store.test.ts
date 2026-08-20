import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  ConversationDefinition,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableRecordStore, isEndpointLastSeenHeartbeat } from "./broker-durable-record-store.js";
import { BrokerDurableStore } from "./broker-durable-store.js";

function createTestRecordStore() {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const appended: BrokerJournalEntry[][] = [];
  const durableStore = new BrokerDurableStore({
    journal: {
      async appendEntries(entries) {
        appended.push(entries);
        return entries;
      },
    },
    projection: {
      async applyEntries() {
        return [];
      },
    },
    threadEvents: {
      publish() {},
    },
  });
  const knownInvocations = new Map<string, InvocationRequest>();
  const records = new BrokerDurableRecordStore({
    runtime,
    durableStore,
    knownInvocations,
  });

  return {
    runtime,
    appended,
    knownInvocations,
    records,
  };
}

function testNode(): NodeDefinition {
  return {
    id: "node-1",
    name: "Node One",
    kind: "local",
    lastSeenAt: 1,
    capabilities: [],
    metadata: {},
  };
}

function testAgent(): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-1",
    labels: ["test"],
    selector: "@agent-1",
    defaultSelector: "@agent-1",
    metadata: { source: "test" },
    agentClass: "general",
    capabilities: ["chat", "invoke"],
    wakePolicy: "on_demand",
    homeNodeId: "node-1",
    authorityNodeId: "node-1",
    advertiseScope: "local",
  };
}

function testEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-1",
    harness: "codex",
    transport: "codex_app_server",
    state: "active",
    sessionId: "session-1",
    metadata: { source: "test", lastSeenAt: 1 },
    ...input,
  };
}

function testConversation(): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Agent One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
  };
}

function testMessage(): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    mentions: [{ actorId: "agent-1", label: "@agent-1" }],
    audience: {
      notify: ["agent-1"],
    },
    visibility: "workspace",
    policy: "durable",
    createdAt: 1,
  };
}

function testInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-1",
    targetAgentId: "agent-1",
    action: "consult",
    task: "hello",
    ensureAwake: true,
    stream: false,
    createdAt: 1,
    ...input,
  };
}

describe("BrokerDurableRecordStore", () => {
  test("detects endpoint last-seen-only heartbeats", () => {
    const previous = testEndpoint({ metadata: { source: "test", lastSeenAt: 1 } });
    const next = testEndpoint({ metadata: { source: "test", lastSeenAt: 2 } });
    const changed = testEndpoint({ state: "idle", metadata: { source: "test", lastSeenAt: 2 } });

    expect(isEndpointLastSeenHeartbeat(previous, next)).toBe(true);
    expect(isEndpointLastSeenHeartbeat(previous, changed)).toBe(false);
  });

  test("refreshes endpoint heartbeat updates without appending journal entries", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertEndpoint(testEndpoint({ metadata: { source: "test", lastSeenAt: 1 } }));

    await records.upsertEndpoint(testEndpoint({ metadata: { source: "test", lastSeenAt: 2 } }));

    expect(appended).toEqual([]);
    expect(runtime.peek().endpoints["endpoint-1"]?.metadata?.lastSeenAt).toBe(2);
  });

  test("deletes endpoints through the durable journal", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertEndpoint(testEndpoint());

    await records.deleteEndpoint("endpoint-1");

    expect(appended).toEqual([
      [{ kind: "agent.endpoint.delete", endpointId: "endpoint-1" }],
    ]);
    expect(runtime.peek().endpoints["endpoint-1"]).toBeUndefined();
  });

  test("records messages with planned deliveries in one durable commit", async () => {
    const { runtime, appended, records } = createTestRecordStore();
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    await runtime.upsertConversation(testConversation());

    const result = await records.recordMessage(testMessage());

    expect(result.deliveries.some((delivery) => delivery.messageId === "message-1")).toBe(true);
    expect(appended[0]?.map((entry) => entry.kind)).toEqual([
      "message.record",
      "deliveries.record",
    ]);
    expect(runtime.snapshot().messages["message-1"]).toEqual(expect.objectContaining({
      id: "message-1",
    }));
  });

  test("records invocations and flights while updating the daemon invocation cache", async () => {
    const { runtime, appended, knownInvocations, records } = createTestRecordStore();
    await runtime.upsertNode(testNode());
    await runtime.upsertAgent(testAgent());
    const flight: FlightRecord = {
      id: "flight-1",
      invocationId: "invocation-1",
      requesterId: "operator",
      targetAgentId: "agent-1",
      state: "queued",
      startedAt: 1,
    };

    const result = await records.recordInvocation(testInvocation(), { flight });

    expect(result.flight).toBe(flight);
    expect(knownInvocations.get("invocation-1")).toEqual(expect.objectContaining({
      id: "invocation-1",
    }));
    expect(appended[0]?.map((entry) => entry.kind)).toEqual([
      "invocation.record",
      "flight.record",
    ]);
    expect(runtime.flightForInvocation("invocation-1")).toEqual(expect.objectContaining({
      id: "flight-1",
    }));
  });
});
