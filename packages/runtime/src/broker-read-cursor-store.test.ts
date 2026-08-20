import { describe, expect, test } from "bun:test";

import type {
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryIntent,
  MessageRecord,
} from "@openscout/protocol";

import { createInMemoryControlRuntime } from "./broker.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerReadCursorStore } from "./broker-read-cursor-store.js";

function testConversation(): ConversationDefinition {
  return {
    id: "conversation-1",
    kind: "direct",
    title: "Conversation One",
    visibility: "workspace",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: ["operator", "agent-1"],
    metadata: {},
  };
}

function testMessage(input: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    actorId: "operator",
    originNodeId: "node-1",
    class: "agent",
    body: "hello",
    visibility: "workspace",
    policy: "durable",
    createdAt: 100,
    ...input,
  };
}

function testDelivery(input: Partial<DeliveryIntent> = {}): DeliveryIntent {
  return {
    id: "delivery-1",
    messageId: "message-1",
    targetId: "agent-1",
    targetKind: "agent",
    transport: "local_socket",
    reason: "direct_message",
    policy: "best_effort",
    status: "pending",
    ...input,
  };
}

function createStore(input: {
  latestThreadSeq?: number;
  deliveries?: DeliveryIntent[];
} = {}) {
  const runtime = createInMemoryControlRuntime({}, { localNodeId: "node-1" });
  const appended: BrokerJournalEntry[][] = [];
  const ensuredActors: string[] = [];
  const deliveryUpdates: unknown[] = [];
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
  const store = new BrokerReadCursorStore({
    runtime,
    durableStore,
    projection: {
      async latestThreadSeq() {
        return input.latestThreadSeq ?? 0;
      },
      async listDeliveries() {
        return input.deliveries ?? [];
      },
    },
    operatorActorId: "operator",
    nodeId: "node-1",
    ensureActor: async (actorId) => {
      ensuredActors.push(actorId);
    },
    updateDeliveryStatus: async (update) => {
      deliveryUpdates.push(update);
    },
  });

  return {
    runtime,
    appended,
    ensuredActors,
    deliveryUpdates,
    store,
  };
}

describe("BrokerReadCursorStore", () => {
  test("records read cursors durably and updates runtime state", async () => {
    const { runtime, appended, store } = createStore();
    const cursor: ConversationReadCursor = {
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-1",
      lastReadAt: 200,
      updatedAt: 250,
    };

    await store.record(cursor);

    expect(appended[0]).toEqual([{ kind: "conversation.read_cursor.upsert", cursor }]);
    expect(runtime.readCursor("conversation-1", "agent-1")).toEqual(cursor);
  });

  test("resolves cursors without regressing existing progress", async () => {
    const { runtime, ensuredActors, store } = createStore({ latestThreadSeq: 5 });
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "message-1", createdAt: 100 }), []);
    await runtime.commitMessage(testMessage({ id: "message-2", createdAt: 200 }), []);
    await runtime.upsertReadCursor({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-2",
      lastReadSeq: 10,
      lastReadAt: 300,
      updatedAt: 350,
    });

    const cursor = await store.resolve("conversation-1", {
      actorId: "agent-1",
      lastReadSeq: 5,
      lastReadAt: 150,
    });

    expect(ensuredActors).toEqual(["agent-1"]);
    expect(cursor).toEqual(expect.objectContaining({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-2",
      lastReadSeq: 10,
      lastReadAt: 300,
    }));
  });

  test("acknowledges readable deliveries at or before the cursor boundary", async () => {
    const deliveries = [
      testDelivery({ id: "delivery-read", messageId: "message-1", status: "pending" }),
      testDelivery({ id: "delivery-unread", messageId: "message-2", status: "pending" }),
      testDelivery({ id: "delivery-completed", messageId: "message-1", status: "completed" }),
    ];
    const { runtime, deliveryUpdates, store } = createStore({ deliveries });
    await runtime.upsertConversation(testConversation());
    await runtime.commitMessage(testMessage({ id: "message-1", createdAt: 100 }), []);
    await runtime.commitMessage(testMessage({ id: "message-2", createdAt: 200 }), []);

    const acknowledged = await store.acknowledgeDeliveries({
      conversationId: "conversation-1",
      actorId: "agent-1",
      readerNodeId: "node-1",
      lastReadMessageId: "message-1",
      lastReadAt: 300,
      updatedAt: 350,
    });

    expect(acknowledged).toBe(1);
    expect(deliveryUpdates).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-read",
        status: "acknowledged",
        leaseOwner: null,
        leaseExpiresAt: null,
        metadata: expect.objectContaining({
          acknowledgedByReadCursor: true,
          readAt: 300,
          readCursorUpdatedAt: 350,
          readMessageId: "message-1",
        }),
      }),
    ]);
  });
});
